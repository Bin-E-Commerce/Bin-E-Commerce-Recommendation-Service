import { CreateDateColumn, Entity, PrimaryColumn } from "typeorm";

// Ledger này ghi nhận từng cặp event đã tạo relation; unique key chống cộng trùng khi Kafka xử lý out-of-order.
@Entity("recommendation_relation_pair_events")
export class RecommendationRelationPairEventEntity {
  // Hai event được sắp xếp ổn định để A-B và B-A dùng cùng một khóa deduplication.
  @PrimaryColumn({ name: "first_event_id", type: "varchar", length: 128 })
  firstEventId!: string;

  @PrimaryColumn({ name: "second_event_id", type: "varchar", length: 128 })
  secondEventId!: string;

  // Một cặp event có thể hợp lệ ở các relation type khác nhau nên type là một phần của khóa chính.
  @PrimaryColumn({ name: "relation_type", type: "varchar", length: 24 })
  relationType!: "CO_VIEW" | "CO_CART" | "CO_PURCHASE";

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
