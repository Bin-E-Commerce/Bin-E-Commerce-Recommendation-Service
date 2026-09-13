// Repository này sở hữu transaction/lease của replay; application chỉ điều phối lifecycle và publish Kafka.

import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { RecommendationReplayJobEntity } from "../../../../database/maintenance/entities/replay-job.entity";
import { RecommendationReplayJobEventEntity } from "../../../../database/maintenance/entities/replay-job-event.entity";

@Injectable()
export class ReplayRepository {
  constructor(
    @InjectRepository(RecommendationReplayJobEntity)
    private readonly jobs: Repository<RecommendationReplayJobEntity>,
    @InjectRepository(RecommendationReplayJobEventEntity)
    private readonly events: Repository<RecommendationReplayJobEventEntity>,
  ) {}

  // Lưu job và payload event cùng transaction để không tồn tại job thiếu event con.
  async create(
    sourceTopic: string,
    payloads: Array<Record<string, unknown>>,
  ): Promise<RecommendationReplayJobEntity> {
    return this.jobs.manager.transaction(async (manager) => {
      const jobRepository = manager.getRepository(
        RecommendationReplayJobEntity,
      );
      const eventRepository = manager.getRepository(
        RecommendationReplayJobEventEntity,
      );
      const job = await jobRepository.save(
        jobRepository.create({
          sourceTopic,
          status: "PENDING",
          totalCount: payloads.length,
          publishedCount: 0,
          failedCount: 0,
          lastError: null,
          availableAt: new Date(),
          leaseUntil: null,
          completedAt: null,
        }),
      );
      if (payloads.length > 0) {
        await eventRepository.insert(
          payloads.map((payload, sequence) => ({
            jobId: job.jobId,
            sequence,
            eventId: payload.eventId as string,
            payload: payload as never,
            status: "PENDING" as const,
            attemptCount: 0,
            lastError: null,
            publishedAt: null,
          })),
        );
      }
      return job;
    });
  }

  // Chỉ trả metadata job, không expose payload event qua status API.
  async findJob(jobId: string): Promise<RecommendationReplayJobEntity | null> {
    return this.jobs.findOne({ where: { jobId } });
  }

  // Thu hồi lease hết hạn và claim một job bằng SKIP LOCKED để nhiều replica không xử lý trùng.
  async claimNextJob(
    leaseMs: number,
  ): Promise<RecommendationReplayJobEntity | null> {
    await this.jobs.query(
      `UPDATE recommendation_replay_jobs
          SET status = 'PENDING', lease_until = NULL, available_at = now(), updated_at = now()
        WHERE status = 'PROCESSING' AND lease_until < now()`,
    );
    return this.jobs.manager.transaction(async (manager) => {
      const rows = (await manager.query(
        `WITH claimed AS (
           SELECT job_id FROM recommendation_replay_jobs
            WHERE status = 'PENDING' AND available_at <= now()
            ORDER BY created_at ASC
            FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE recommendation_replay_jobs job
            SET status = 'PROCESSING', lease_until = now() + ($1 * INTERVAL '1 millisecond'), updated_at = now()
           FROM claimed
          WHERE job.job_id = claimed.job_id
         RETURNING job.job_id`,
        [leaseMs],
      )) as Array<{ job_id: string }>;
      if (rows.length === 0) return null;
      return manager.getRepository(RecommendationReplayJobEntity).findOne({
        where: { jobId: rows[0]!.job_id },
      });
    });
  }

  // Lấy event pending theo sequence để replay giữ thứ tự và resume được sau crash.
  async findPendingEvents(
    jobId: string,
  ): Promise<RecommendationReplayJobEventEntity[]> {
    return this.events.find({
      where: { jobId, status: "PENDING" },
      order: { sequence: "ASC" },
    });
  }

  // Đánh dấu event publish thành công và tăng aggregate counter trong cùng transaction.
  async markPublished(eventRowId: string, jobId: string): Promise<void> {
    await this.jobs.manager.transaction(async (manager) => {
      const eventRepository = manager.getRepository(
        RecommendationReplayJobEventEntity,
      );
      const result = await eventRepository.update(
        { eventRowId, status: "PENDING" },
        {
          status: "PUBLISHED",
          publishedAt: new Date(),
          lastError: null,
        },
      );
      if (result.affected !== 1) return;
      await manager
        .getRepository(RecommendationReplayJobEntity)
        .increment({ jobId }, "publishedCount", 1);
    });
  }

  // Ghi nhận event lỗi cuối cùng và đóng job để poison event không bị retry vô hạn.
  async markFailed(
    eventRowId: string,
    jobId: string,
    attemptCount: number,
    errorCode: string,
  ): Promise<void> {
    await this.jobs.manager.transaction(async (manager) => {
      const eventRepository = manager.getRepository(
        RecommendationReplayJobEventEntity,
      );
      const result = await eventRepository.update(
        { eventRowId, status: "PENDING" },
        { status: "FAILED", attemptCount, lastError: errorCode },
      );
      if (result.affected !== 1) return;
      const jobRepository = manager.getRepository(
        RecommendationReplayJobEntity,
      );
      await jobRepository.increment({ jobId }, "failedCount", 1);
      await jobRepository.update(
        { jobId },
        {
          status: "FAILED",
          lastError: errorCode,
          leaseUntil: null,
          completedAt: new Date(),
          updatedAt: new Date(),
        },
      );
    });
  }

  // Cập nhật attempt và delay ở một nơi để worker không tự thao tác persistence ngoài repository.
  async scheduleRetry(
    eventRowId: string,
    jobId: string,
    attemptCount: number,
    errorCode: string,
    availableAt: Date,
  ): Promise<void> {
    await this.jobs.manager.transaction(async (manager) => {
      const eventRepository = manager.getRepository(
        RecommendationReplayJobEventEntity,
      );
      const result = await eventRepository.update(
        { eventRowId, status: "PENDING" },
        { attemptCount, lastError: errorCode },
      );
      if (result.affected !== 1) return;
      await manager.getRepository(RecommendationReplayJobEntity).update(
        { jobId, status: "PROCESSING" },
        {
          status: "PENDING",
          availableAt,
          leaseUntil: null,
          lastError: errorCode,
          updatedAt: new Date(),
        },
      );
    });
  }

  // Đóng job khi toàn bộ event đã publish; update có điều kiện tránh ghi đè trạng thái FAILED.
  async markCompleted(jobId: string): Promise<void> {
    await this.jobs.update(
      { jobId, status: "PROCESSING" },
      {
        status: "COMPLETED",
        leaseUntil: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      },
    );
  }
}
