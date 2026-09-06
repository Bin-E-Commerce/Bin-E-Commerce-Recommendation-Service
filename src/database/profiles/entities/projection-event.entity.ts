// Entity này là idempotency ledger riêng cho profile projection, bảo vệ điểm sở thích khỏi Kafka redelivery.

import { CreateDateColumn, Entity, PrimaryColumn } from "typeorm";

@Entity("recommendation_projection_events")
export class RecommendationProjectionEventEntity {
  // Event ID đã được profile projection xử lý; primary key biến việc Kafka redelivery thành thao tác idempotent.
  @PrimaryColumn({ name: "event_id", type: "varchar", length: 128 })
  eventId!: string;

  // Thời điểm event được ghi vào ledger, phục vụ audit và theo dõi độ trễ projection.
  @CreateDateColumn({ name: "processed_at", type: "timestamptz" })
  processedAt!: Date;
}
