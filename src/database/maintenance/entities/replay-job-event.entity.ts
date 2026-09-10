import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

// Lưu bounded raw event của internal replay để không phụ thuộc vào một HTTP request dài hoặc DLQ retention.
@Entity("recommendation_replay_job_events")
@Index("uq_recommendation_replay_job_events_sequence", ["jobId", "sequence"], {
  unique: true,
})
@Index("idx_recommendation_replay_job_events_pending", [
  "jobId",
  "status",
  "sequence",
])
export class RecommendationReplayJobEventEntity {
  @PrimaryGeneratedColumn("uuid", { name: "event_row_id" })
  eventRowId!: string;

  @Column({ name: "job_id", type: "uuid" })
  jobId!: string;

  @Column({ name: "sequence", type: "integer" })
  sequence!: number;

  @Column({ name: "event_id", type: "varchar", length: 255 })
  eventId!: string;

  @Column({ name: "payload", type: "jsonb" })
  payload!: Record<string, unknown>;

  @Column({ name: "status", type: "varchar", length: 16, default: "PENDING" })
  status!: "PENDING" | "PUBLISHED" | "FAILED";

  @Column({ name: "attempt_count", type: "integer", default: 0 })
  attemptCount!: number;

  @Column({ name: "last_error", type: "varchar", length: 255, nullable: true })
  lastError!: string | null;

  @Column({ name: "published_at", type: "timestamptz", nullable: true })
  publishedAt!: Date | null;
}
