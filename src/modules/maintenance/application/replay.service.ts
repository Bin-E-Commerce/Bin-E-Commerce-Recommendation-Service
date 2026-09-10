// Application worker replay event từ internal operator, lưu durable payload và retry qua đúng Kafka pipeline.

import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository } from "typeorm";
import { KafkaProducerService } from "../../../kafka/producers/kafka-producer.service";
import { RECOMMENDATION_REPLAYABLE_TOPICS } from "../../../kafka/config/kafka.constants";
import { RecommendationReplayJobEntity } from "../../../database/maintenance/entities/replay-job.entity";
import { RecommendationReplayJobEventEntity } from "../../../database/maintenance/entities/replay-job-event.entity";
import { CreateReplayJobDto } from "../presentation/dto/create-replay-job.dto";

const REPLAY_INTERVAL_MS = 2000;
const REPLAY_LEASE_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;

@Injectable()
export class ReplayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReplayService.name);
  private workerTimer?: NodeJS.Timeout;

  constructor(
    @InjectRepository(RecommendationReplayJobEntity)
    private readonly repository: Repository<RecommendationReplayJobEntity>,
    @InjectRepository(RecommendationReplayJobEventEntity)
    private readonly eventRepository: Repository<RecommendationReplayJobEventEntity>,
    private readonly producer: KafkaProducerService,
    private readonly config: ConfigService,
  ) {}

  // Chạy worker riêng để POST chỉ tạo job nhanh, không giữ HTTP connection trong lúc publish hàng loạt.
  onModuleInit(): void {
    this.workerTimer = setInterval(
      () => void this.processNextSafe(),
      REPLAY_INTERVAL_MS,
    );
    void this.processNextSafe();
  }

  // Dừng worker khi shutdown để không mở thêm publish mới trong lúc service đang thoát.
  onModuleDestroy(): void {
    if (this.workerTimer) clearInterval(this.workerTimer);
  }

  // Xác thực input, lưu job và toàn bộ event trong một transaction để job không có metadata thiếu payload.
  async create(
    input: CreateReplayJobDto,
    token: string | undefined,
  ): Promise<RecommendationReplayJobEntity> {
    this.assertInternalToken(token);
    if (
      !(RECOMMENDATION_REPLAYABLE_TOPICS as readonly string[]).includes(
        input.sourceTopic,
      )
    ) {
      throw new UnauthorizedException("Replay topic is not allowed");
    }
    const normalizedEvents = input.events.map((event) =>
      this.normalizeReplayEvent(event),
    );
    const eventIds = normalizedEvents.map((event) => event.eventId as string);
    if (new Set(eventIds).size !== eventIds.length) {
      throw new UnauthorizedException(
        "Replay events must have unique eventId values",
      );
    }

    return this.repository.manager.transaction(async (manager) => {
      const jobRepository = manager.getRepository(
        RecommendationReplayJobEntity,
      );
      const eventRepository = manager.getRepository(
        RecommendationReplayJobEventEntity,
      );
      const job = await jobRepository.save(
        jobRepository.create({
          sourceTopic: input.sourceTopic,
          status: "PENDING",
          totalCount: normalizedEvents.length,
          publishedCount: 0,
          failedCount: 0,
          lastError: null,
          availableAt: new Date(),
          leaseUntil: null,
          completedAt: null,
        }),
      );
      if (normalizedEvents.length > 0) {
        await eventRepository.insert(
          normalizedEvents.map((event, sequence) => ({
            jobId: job.jobId,
            sequence,
            eventId: event.eventId as string,
            payload: event as never,
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

  // Trả trạng thái job cho operator; payload event không bao giờ được trả qua status API.
  async get(
    jobId: string,
    token: string | undefined,
  ): Promise<RecommendationReplayJobEntity> {
    this.assertInternalToken(token);
    const job = await this.repository.findOne({ where: { jobId } });
    if (!job) throw new NotFoundException("Replay job not found");
    return job;
  }

  // Claim một job bằng SKIP LOCKED để nhiều replica không xử lý cùng job; lease cho phép resume sau crash.
  private async claimNextJob(): Promise<RecommendationReplayJobEntity | null> {
    await this.repository.query(
      `UPDATE recommendation_replay_jobs
          SET status = 'PENDING', lease_until = NULL, available_at = now(), updated_at = now()
        WHERE status = 'PROCESSING' AND lease_until < now()`,
    );
    return this.repository.manager.transaction(async (manager) => {
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
        [REPLAY_LEASE_MS],
      )) as Array<{ job_id: string }>;
      if (rows.length === 0) return null;
      return manager.getRepository(RecommendationReplayJobEntity).findOne({
        where: { jobId: rows[0]!.job_id },
      });
    });
  }

  // Xử lý tuần tự từng event, giữ eventId ổn định để downstream idempotent nếu crash sau Kafka ack.
  private async processNext(): Promise<void> {
    const job = await this.claimNextJob();
    if (!job) return;
    const events = await this.eventRepository.find({
      where: { jobId: job.jobId, status: "PENDING" },
      order: { sequence: "ASC" },
    });
    if (events.length === 0) {
      await this.repository.update(
        { jobId: job.jobId },
        {
          status: "COMPLETED",
          leaseUntil: null,
          completedAt: new Date(),
          updatedAt: new Date(),
        },
      );
      return;
    }

    const maxAttempts = this.config.get<number>(
      "REPLAY_MAX_ATTEMPTS",
      DEFAULT_MAX_ATTEMPTS,
    );
    for (const event of events) {
      try {
        await this.producer.publish(
          job.sourceTopic,
          event.eventId,
          event.payload,
        );
        await this.eventRepository.update(
          { eventRowId: event.eventRowId },
          {
            status: "PUBLISHED",
            publishedAt: new Date(),
            lastError: null,
          },
        );
        await this.repository.increment(
          { jobId: job.jobId },
          "publishedCount",
          1,
        );
      } catch (error) {
        const attemptCount = event.attemptCount + 1;
        const lastError =
          error instanceof Error ? error.name.slice(0, 255) : "PUBLISH_FAILED";
        if (attemptCount >= maxAttempts) {
          await this.eventRepository.update(
            { eventRowId: event.eventRowId },
            { status: "FAILED", attemptCount, lastError },
          );
          await this.repository.increment(
            { jobId: job.jobId },
            "failedCount",
            1,
          );
          await this.repository.update(
            { jobId: job.jobId },
            {
              status: "FAILED",
              lastError,
              leaseUntil: null,
              completedAt: new Date(),
              updatedAt: new Date(),
            },
          );
        } else {
          const delaySeconds = Math.min(3600, 2 ** Math.min(attemptCount, 10));
          await this.eventRepository.update(
            { eventRowId: event.eventRowId },
            { attemptCount, lastError },
          );
          await this.repository.update(
            {
              jobId: job.jobId,
            },
            {
              status: "PENDING",
              availableAt: new Date(Date.now() + delaySeconds * 1000),
              leaseUntil: null,
              lastError,
              updatedAt: new Date(),
            },
          );
        }
        return;
      }
    }
    await this.repository.update(
      { jobId: job.jobId },
      {
        status: "COMPLETED",
        leaseUntil: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      },
    );
  }

  // Bọc lỗi worker để broker/database tạm lỗi không tạo unhandled rejection trong Nest process.
  private async processNextSafe(): Promise<void> {
    try {
      await this.processNext();
    } catch (error) {
      this.logger.warn(
        `Replay worker deferred: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  }

  // Chấp nhận DLQ envelope hoặc originalEvent nhưng bắt buộc eventId để replay không nhân đôi tín hiệu.
  private normalizeReplayEvent(
    event: Record<string, unknown>,
  ): Record<string, unknown> {
    const original = event.originalEvent;
    const replayEvent =
      original && typeof original === "object" && !Array.isArray(original)
        ? (original as Record<string, unknown>)
        : event;
    if (
      typeof replayEvent.eventId !== "string" ||
      replayEvent.eventId.trim() === ""
    ) {
      throw new UnauthorizedException(
        "Replay event must contain a stable eventId",
      );
    }
    if (
      typeof replayEvent.eventName !== "string" ||
      replayEvent.eventName.trim() === ""
    ) {
      throw new UnauthorizedException("Replay event must contain eventName");
    }
    return replayEvent;
  }

  // Reject token thiếu hoặc sai trước khi tạo/publish bất kỳ event nào.
  private assertInternalToken(token: string | undefined): void {
    const expected = this.config.get<string>("INTERNAL_SERVICE_TOKEN", "");
    if (!expected || token !== expected)
      throw new UnauthorizedException("Invalid internal token");
  }
}
