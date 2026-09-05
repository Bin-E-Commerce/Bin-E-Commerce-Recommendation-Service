// Entity này lưu read model interaction do Recommendation Service sở hữu, không tham chiếu trực tiếp database service khác.

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

@Entity("recommendation_interactions")
@Index("idx_recommendation_interactions_user_occurred", ["userId", "occurredAt"])
@Index("idx_recommendation_interactions_session_occurred", ["sessionId", "occurredAt"])
@Index("idx_recommendation_interactions_product_occurred", ["productId", "occurredAt"])
export class RecommendationInteractionEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "event_id", type: "varchar", length: 128, unique: true })
  eventId!: string;

  @Column({ name: "event_name", type: "varchar", length: 128 })
  eventName!: string;

  @Column({ name: "event_version", type: "integer" })
  eventVersion!: number;

  @Column({ type: "varchar", length: 128 })
  source!: string;

  @Column({ name: "occurred_at", type: "timestamptz" })
  occurredAt!: Date;

  @Column({ name: "user_id", type: "varchar", length: 128, nullable: true })
  userId!: string | null;

  @Column({ name: "session_id", type: "varchar", length: 128, nullable: true })
  sessionId!: string | null;

  @Column({ name: "interaction_type", type: "varchar", length: 64 })
  interactionType!: string;

  @Column({ name: "product_id", type: "varchar", length: 128, nullable: true })
  productId!: string | null;

  @Column({ name: "variant_id", type: "varchar", length: 128, nullable: true })
  variantId!: string | null;

  @Column({ name: "category_id", type: "varchar", length: 128, nullable: true })
  categoryId!: string | null;

  @Column({ type: "varchar", length: 255, nullable: true })
  query!: string | null;

  @Column({ type: "varchar", length: 80, nullable: true })
  page!: string | null;

  @Column({ type: "integer", nullable: true })
  position!: number | null;

  @Column({ type: "integer", nullable: true })
  quantity!: number | null;

  @Column({ name: "request_id", type: "varchar", length: 128, nullable: true })
  requestId!: string | null;

  @Column({ type: "jsonb", default: {} })
  metadata!: Record<string, string>;

  @Column({ name: "processing_status", type: "varchar", length: 32, default: "PROCESSED" })
  processingStatus!: "PROCESSED" | "FAILED";

  @Column({ name: "processing_error", type: "text", nullable: true })
  processingError!: string | null;

  @CreateDateColumn({ name: "received_at", type: "timestamptz" })
  receivedAt!: Date;

  @Column({ name: "processed_at", type: "timestamptz", nullable: true })
  processedAt!: Date | null;
}
