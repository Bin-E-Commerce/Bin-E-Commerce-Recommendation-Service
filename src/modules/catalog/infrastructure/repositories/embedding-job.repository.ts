import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { RecommendationEmbeddingJobEntity } from '@/database/embedding/entities/embedding-job.entity';

type RawEmbeddingJobRow = Record<string, unknown>;

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
            embeddingProfile: 'product-content-v1';
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
           status = CASE
             WHEN recommendation_embedding_jobs.status = 'SUPERSEDED'
               OR recommendation_embedding_jobs.model_version <> EXCLUDED.model_version
               THEN 'PENDING'
             ELSE recommendation_embedding_jobs.status
           END,
           attempt_count = CASE
             WHEN recommendation_embedding_jobs.status = 'SUPERSEDED'
               OR recommendation_embedding_jobs.model_version <> EXCLUDED.model_version
               THEN 0
             ELSE recommendation_embedding_jobs.attempt_count
           END,
           leased_until = CASE
             WHEN recommendation_embedding_jobs.status = 'SUPERSEDED'
               OR recommendation_embedding_jobs.model_version <> EXCLUDED.model_version
               THEN NULL
             ELSE recommendation_embedding_jobs.leased_until
           END,
           available_at = CASE
             WHEN recommendation_embedding_jobs.status = 'SUPERSEDED'
               OR recommendation_embedding_jobs.model_version <> EXCLUDED.model_version
               THEN now()
             ELSE recommendation_embedding_jobs.available_at
           END,
           last_error_code = CASE
             WHEN recommendation_embedding_jobs.status = 'SUPERSEDED'
               OR recommendation_embedding_jobs.model_version <> EXCLUDED.model_version
               THEN NULL
             ELSE recommendation_embedding_jobs.last_error_code
           END,
           last_error_at = CASE
             WHEN recommendation_embedding_jobs.status = 'SUPERSEDED'
               OR recommendation_embedding_jobs.model_version <> EXCLUDED.model_version
               THEN NULL
             ELSE recommendation_embedding_jobs.last_error_at
           END,
           completed_at = CASE
             WHEN recommendation_embedding_jobs.status = 'SUPERSEDED'
               OR recommendation_embedding_jobs.model_version <> EXCLUDED.model_version
               THEN NULL
             ELSE recommendation_embedding_jobs.completed_at
           END,
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
        maxAttempts = 8,
    ): Promise<RecommendationEmbeddingJobEntity[]> {
        const safeMaxAttempts = Math.min(
            Math.max(Math.trunc(maxAttempts), 1),
            100,
        );
        await this.repository.query(
            `UPDATE recommendation_embedding_jobs
          SET status = CASE WHEN attempt_count >= $1 THEN 'FAILED' ELSE 'PENDING' END,
              leased_until = NULL,
              available_at = CASE WHEN attempt_count >= $1 THEN available_at ELSE now() END,
              last_error_code = CASE WHEN attempt_count >= $1 THEN 'EMBEDDING_PROCESSING_LEASE_EXPIRED' ELSE last_error_code END,
              last_error_at = CASE WHEN attempt_count >= $1 THEN now() ELSE last_error_at END,
              updated_at = now()
        WHERE status = 'PROCESSING' AND leased_until IS NOT NULL AND leased_until < now()`,
            [safeMaxAttempts],
        );
        // DISPATCHED có lease chờ generated event; hết lease thì phát lại để request không mắc vĩnh viễn.
        await this.repository.query(
            `UPDATE recommendation_embedding_jobs
          SET status = CASE WHEN attempt_count >= $1 THEN 'FAILED' ELSE 'PENDING' END,
              leased_until = NULL,
              available_at = CASE WHEN attempt_count >= $1 THEN available_at ELSE now() END,
              last_error_code = 'EMBEDDING_ACK_TIMEOUT',
              last_error_at = now(),
              updated_at = now()
        WHERE status = 'DISPATCHED' AND leased_until IS NOT NULL AND leased_until < now()`,
            [safeMaxAttempts],
        );
        const queryResult = await this.repository.query(
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
        );
        // Một số TypeORM/Postgres driver versions trả [rows, rowCount] thay vì rows trực tiếp;
        // lấy đúng phần row trước khi normalize để không biến cả batch thành một row có key 0..N.
        const rows = Array.isArray(queryResult[0])
            ? queryResult[0]
            : queryResult;

        // TypeORM raw drivers may return either quoted camelCase aliases or physical snake_case columns;
        // normalize both shapes before the dispatcher builds the Kafka contract so undefined fields cannot reach AI workers.
        return rows.map((row: RawEmbeddingJobRow) =>
            this.normalizeLeasedJob(row),
        );
    }

    // Chuẩn hóa raw row thành entity contract ổn định trước khi lease được publish sang Kafka.
    private normalizeLeasedJob(
        row: RawEmbeddingJobRow,
    ): RecommendationEmbeddingJobEntity {
        const jobId = this.readRequiredString(
            row.jobId ?? row.jobid ?? row.job_id,
            'jobId',
        );
        const productId = this.readRequiredString(
            row.productId ?? row.productid ?? row.product_id,
            'productId',
        );
        const contentHash = this.readRequiredString(
            row.contentHash ?? row.contenthash ?? row.content_hash,
            'contentHash',
        );
        const embeddingProfile = this.readRequiredString(
            row.embeddingProfile ??
                row.embeddingprofile ??
                row.embedding_profile,
            'embeddingProfile',
        );
        const modelVersion = this.readRequiredString(
            row.modelVersion ?? row.modelversion ?? row.model_version,
            'modelVersion',
        );
        const textContent = this.readRequiredString(
            row.textContent ?? row.textcontent ?? row.text_content,
            'textContent',
        );

        return {
            jobId,
            productId,
            contentHash,
            embeddingProfile: embeddingProfile as 'product-content-v1',
            modelVersion,
            textContent,
            status: (row.status ??
                'PROCESSING') as RecommendationEmbeddingJobEntity['status'],
            attemptCount: Number(
                row.attemptCount ?? row.attemptcount ?? row.attempt_count ?? 0,
            ),
            leasedUntil: (row.leasedUntil ??
                row.leaseduntil ??
                row.leased_until ??
                null) as Date | null,
            availableAt: (row.availableAt ??
                row.availableat ??
                row.available_at) as Date,
            lastErrorCode: (row.lastErrorCode ??
                row.lasterrorcode ??
                row.last_error_code ??
                null) as string | null,
            lastErrorAt: (row.lastErrorAt ??
                row.lasterrorat ??
                row.last_error_at ??
                null) as Date | null,
            createdAt: (row.createdAt ??
                row.createdat ??
                row.created_at) as Date,
            updatedAt: (row.updatedAt ??
                row.updatedat ??
                row.updated_at) as Date,
            completedAt: (row.completedAt ??
                row.completedat ??
                row.completed_at ??
                null) as Date | null,
        };
    }

    // Từ chối row thiếu dữ liệu bắt buộc để không phát Kafka event hỏng và làm worker đẩy vào DLQ.
    private readRequiredString(value: unknown, field: string): string {
        if (typeof value !== 'string' || value.trim() === '') {
            throw new Error(`EMBEDDING_JOB_ROW_MISSING_${field}`);
        }
        return value;
    }

    // Chỉ đánh dấu dispatched sau khi Kafka producer xác nhận publish thành công.
    async markDispatched(
        jobId: string,
        acknowledgementTimeoutSeconds: number,
    ): Promise<void> {
        await this.repository.update(
            { jobId, status: 'PROCESSING' },
            {
                status: 'DISPATCHED',
                leasedUntil: new Date(
                    Date.now() +
                        Math.max(10, acknowledgementTimeoutSeconds) * 1000,
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
            { jobId, status: 'PROCESSING' },
            {
                status: 'FAILED',
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
            [
                input.jobId,
                input.productId,
                input.contentHash,
                input.modelVersion,
            ],
        );
    }
}
