// Entity lưu trạng thái replay để operator theo dõi được tiến độ và không phải tin vào một HTTP request dài.

import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from "typeorm";

// Replay job giữ lifecycle và lease; payload nằm ở bảng event con để worker có thể resume sau crash.
@Entity("recommendation_replay_jobs")
export class RecommendationReplayJobEntity {
  @PrimaryGeneratedColumn("uuid", { name: "job_id" })
  jobId!: string;

  @Column({ name: "source_topic", type: "varchar", length: 200 })
  sourceTopic!: string;

  @Column({ name: "status", type: "varchar", length: 16, default: "PENDING" })
  status!: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";

  @Column({ name: "total_count", type: "integer" })
  totalCount!: number;

  @Column({ name: "published_count", type: "integer", default: 0 })
  publishedCount!: number;

  @Column({ name: "failed_count", type: "integer", default: 0 })
  failedCount!: number;

  @Column({ name: "last_error", type: "varchar", length: 255, nullable: true })
  lastError!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @Column({ name: "updated_at", type: "timestamptz", default: () => "now()" })
  updatedAt!: Date;

  @Column({ name: "available_at", type: "timestamptz", default: () => "now()" })
  availableAt!: Date;

  @Column({ name: "lease_until", type: "timestamptz", nullable: true })
  leaseUntil!: Date | null;

  @Column({ name: "completed_at", type: "timestamptz", nullable: true })
  completedAt!: Date | null;
}
