import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { EntityManager, Repository } from "typeorm";
import { RecommendationEmbeddingJobEntity } from "../../../../database/embedding/entities/embedding-job.entity";

// Repository giữ toàn bộ SQL lease/idempotency của embedding dispatcher ngoài application service.
@Injectable()
export class EmbeddingJobRepository {
  constructor(
    @InjectRepository(RecommendationEmbeddingJobEntity)
    private readonly repository: Repository<RecommendationEmbeddingJobEntity>,
  ) {}

  // Tạo job duy nhất cho một content hash; content mới sẽ supersede job cũ chưa dispatch.
  async enqueue(
    input: {
      productId: string;
      contentHash: string;
      embeddingProfile: "product-content-v1";
      modelVersion: string;
      textContent: string;
    },
    manager: EntityManager = this.repository.manager,
  ): Promise<void> {
    await manager.query(
      `UPDATE recommendation_embedding_jobs
       SET status = 'SUPERSEDED', leased_until = NULL, updated_at = now()
       WHERE product_id = $1 AND content_hash <> $2 AND status IN ('PENDING', 'PROCESSING', 'DISPATCHED')`,
      [input.productId, input.contentHash],
    );
    await manager.query(
      `INSERT INTO recommendation_embedding_jobs
       (product_id, content_hash, embedding_profile, model_version, text_content, status)
       VALUES ($1, $2, $3, $4, $5, 'PENDING')
       ON CONFLICT (product_id, content_hash, embedding_profile) DO UPDATE
       SET text_content = EXCLUDED.text_content,
           model_version = EXCLUDED.model_version,
           status = CASE WHEN recommendation_embedding_jobs.status IN ('FAILED', 'SUPERSEDED', 'DISPATCHED', 'COMPLETED') OR recommendation_embedding_jobs.model_version <> EXCLUDED.model_version THEN 'PENDING' ELSE recommendation_embedding_jobs.status END,
           available_at = CASE WHEN recommendation_embedding_jobs.status IN ('FAILED', 'SUPERSEDED', 'DISPATCHED', 'COMPLETED') OR recommendation_embedding_jobs.model_version <> EXCLUDED.model_version THEN now() ELSE recommendation_embedding_jobs.available_at END,
           updated_at = now()`,
      [
        input.productId,
        input.contentHash,
        input.embeddingProfile,
        input.modelVersion,
        input.textContent,
      ],
    );
  }

  // Lease một batch bằng SKIP LOCKED để nhiều Recommendation instance không dispatch trùng job.
  async leaseBatch(
    limit: number,
    leaseSeconds: number,
  ): Promise<RecommendationEmbeddingJobEntity[]> {
    await this.repository.query(
      `UPDATE recommendation_embedding_jobs
          SET status = 'PENDING', leased_until = NULL, available_at = now(), updated_at = now()
        WHERE status = 'PROCESSING' AND leased_until < now()`,
    );
    // DISPATCHED có lease chờ generated event; hết lease thì phát lại để request không mắc vĩnh viễn.
    await this.repository.query(
      `UPDATE recommendation_embedding_jobs
          SET status = 'PENDING', leased_until = NULL, available_at = now(),
              last_error_code = 'EMBEDDING_ACK_TIMEOUT', last_error_at = now(), updated_at = now()
        WHERE status = 'DISPATCHED' AND leased_until IS NOT NULL AND leased_until < now()`,
    );
    return this.repository.query(
      `WITH claimed AS (
         SELECT job_id FROM recommendation_embedding_jobs
         WHERE status = 'PENDING' AND available_at <= now()
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED LIMIT $1
       )
       UPDATE recommendation_embedding_jobs job
       SET status = 'PROCESSING', leased_until = now() + ($2 * interval '1 second'),
           attempt_count = job.attempt_count + 1, updated_at = now()
       FROM claimed WHERE job.job_id = claimed.job_id
       RETURNING
         job.job_id AS "jobId",
         job.product_id AS "productId",
         job.content_hash AS "contentHash",
         job.embedding_profile AS "embeddingProfile",
         job.model_version AS "modelVersion",
         job.text_content AS "textContent",
         job.status AS "status",
         job.attempt_count AS "attemptCount",
         job.leased_until AS "leasedUntil",
         job.available_at AS "availableAt",
         job.last_error_code AS "lastErrorCode",
         job.last_error_at AS "lastErrorAt",
         job.created_at AS "createdAt",
         job.updated_at AS "updatedAt",
         job.completed_at AS "completedAt"`,
      [Math.min(Math.max(limit, 1), 100), leaseSeconds],
    ) as Promise<RecommendationEmbeddingJobEntity[]>;
  }

  // Chỉ đánh dấu dispatched sau khi Kafka producer xác nhận publish thành công.
  async markDispatched(
    jobId: string,
    acknowledgementTimeoutSeconds: number,
  ): Promise<void> {
    await this.repository.update(
      { jobId, status: "PROCESSING" },
      {
        status: "DISPATCHED",
        leasedUntil: new Date(
          Date.now() + Math.max(10, acknowledgementTimeoutSeconds) * 1000,
        ),
      },
    );
  }

  // Trả job về pending với exponential backoff bounded khi Kafka tạm thời unavailable.
  async markRetry(
    jobId: string,
    errorCode: string,
    delaySeconds: number,
  ): Promise<void> {
    await this.repository.query(
      `UPDATE recommendation_embedding_jobs
       SET status = 'PENDING', leased_until = NULL, available_at = now() + ($2 * interval '1 second'),
           last_error_code = $3, last_error_at = now(), updated_at = now()
       WHERE job_id = $1 AND status = 'PROCESSING'`,
      [
        jobId,
        Math.min(Math.max(delaySeconds, 1), 3600),
        errorCode.slice(0, 128),
      ],
    );
  }

  // Chuyển job sang FAILED sau bounded attempts để job hỏng không bị poll vô hạn nhưng vẫn còn dấu vết vận hành.
  async markFailed(jobId: string, errorCode: string): Promise<void> {
    await this.repository.update(
      { jobId, status: "PROCESSING" },
      {
        status: "FAILED",
        leasedUntil: null,
        lastErrorCode: errorCode.slice(0, 128),
        lastErrorAt: new Date(),
      },
    );
  }

  // Đóng job không còn hợp lệ khi product/content đã biến mất; tránh dispatcher phát lại vô hạn một completion stale.
  async markSuperseded(input: {
    jobId: string;
    productId: string;
    contentHash: string;
    modelVersion: string;
    errorCode: string;
  }): Promise<void> {
    await this.repository.query(
      `UPDATE recommendation_embedding_jobs
          SET status = 'SUPERSEDED', leased_until = NULL,
              last_error_code = $5, last_error_at = now(), updated_at = now()
        WHERE job_id = $1 AND product_id = $2 AND content_hash = $3
          AND model_version = $4 AND status IN ('PENDING', 'PROCESSING', 'DISPATCHED')`,
      [
        input.jobId,
        input.productId,
        input.contentHash,
        input.modelVersion,
        input.errorCode.slice(0, 128),
      ],
    );
  }

  // Chỉ hoàn tất đúng job/product/content/model đã phát sinh vector, tránh completion cũ đóng nhầm job mới.
  async markCompleted(input: {
    jobId: string;
    productId: string;
    contentHash: string;
    modelVersion: string;
  }): Promise<void> {
    await this.repository.query(
      `UPDATE recommendation_embedding_jobs
          SET status = 'COMPLETED', completed_at = now(), leased_until = NULL, updated_at = now()
        WHERE job_id = $1 AND product_id = $2 AND content_hash = $3
          AND model_version = $4 AND status IN ('PROCESSING', 'DISPATCHED')`,
      [input.jobId, input.productId, input.contentHash, input.modelVersion],
    );
  }
}
