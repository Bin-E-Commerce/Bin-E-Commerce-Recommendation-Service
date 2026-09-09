import { CreateDateColumn, Entity, PrimaryColumn } from "typeorm";

// Ledger idempotency riêng cho relation projector để retry Kafka không cộng quan hệ hai lần.
@Entity("recommendation_relation_projection_events")
export class RecommendationRelationProjectionEventEntity {
  @PrimaryColumn({ name: "event_id", type: "varchar", length: 128 })
  eventId!: string;

  @PrimaryColumn({ name: "projection_type", type: "varchar", length: 64 })
  projectionType!: string;

  @CreateDateColumn({ name: "processed_at", type: "timestamptz" })
  processedAt!: Date;
}
