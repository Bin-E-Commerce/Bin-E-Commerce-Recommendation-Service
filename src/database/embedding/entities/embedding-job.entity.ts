import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from "typeorm";

// Entity này quản lý durable dispatch, giúp catalog commit không mất yêu cầu embedding khi Kafka tạm thời lỗi.
@Entity("recommendation_embedding_jobs")
@Unique("UQ_recommendation_embedding_job_content", ["productId", "contentHash", "embeddingProfile"])
@Index("idx_recommendation_embedding_jobs_ready", ["status", "availableAt"])
export class RecommendationEmbeddingJobEntity {
  @PrimaryGeneratedColumn("uuid", { name: "job_id" })
  // Stable job identity được AI worker gửi lại trong generated event để completion có thể đối chiếu.
  jobId!: string;

  @Column({ name: "product_id", type: "varchar", length: 128 })
  productId!: string;

  @Column({ name: "content_hash", type: "varchar", length: 128 })
  contentHash!: string;

  @Column({ name: "embedding_profile", type: "varchar", length: 64 })
  embeddingProfile!: "product-content-v1";

  @Column({ name: "model_version", type: "varchar", length: 128 })
  modelVersion!: string;

  @Column({ name: "text_content", type: "text" })
  textContent!: string;

  @Column({ name: "status", type: "varchar", length: 16, default: "PENDING" })
  // DISPATCHED vẫn còn lease chờ generated event; hết lease sẽ được dispatcher đưa về PENDING.
  status!: "PENDING" | "PROCESSING" | "DISPATCHED" | "COMPLETED" | "SUPERSEDED" | "FAILED";

  @Column({ name: "attempt_count", type: "integer", default: 0 })
  attemptCount!: number;

  @Column({ name: "leased_until", type: "timestamptz", nullable: true })
  // Thời điểm hết quyền xử lý hiện tại, dùng cho recovery sau crash hoặc timeout acknowledgement.
  leasedUntil!: Date | null;

  @Column({ name: "available_at", type: "timestamptz", default: () => "now()" })
  availableAt!: Date;

  @Column({ name: "last_error_code", type: "varchar", length: 128, nullable: true })
  lastErrorCode!: string | null;

  @Column({ name: "last_error_at", type: "timestamptz", nullable: true })
  lastErrorAt!: Date | null;

  @Column({ name: "created_at", type: "timestamptz", default: () => "now()" })
  createdAt!: Date;

  @Column({ name: "updated_at", type: "timestamptz", default: () => "now()" })
  updatedAt!: Date;

  @Column({ name: "completed_at", type: "timestamptz", nullable: true })
  completedAt!: Date | null;
}
