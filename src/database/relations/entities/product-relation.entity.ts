import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from "typeorm";

// Read model quan hệ product-to-product do Recommendation sở hữu, dùng cho co-view/co-cart/co-purchase candidates.
@Entity("recommendation_product_relations")
@Unique("UQ_recommendation_product_relation", ["sourceProductId", "targetProductId", "relationType"])
@Index("IDX_recommendation_product_relation_source", ["sourceProductId", "relationType", "relationScore"])
export class RecommendationProductRelationEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "source_product_id", type: "varchar", length: 128 })
  sourceProductId!: string;

  @Column({ name: "target_product_id", type: "varchar", length: 128 })
  targetProductId!: string;

  @Column({ name: "relation_type", type: "varchar", length: 24 })
  relationType!: "CO_VIEW" | "CO_CART" | "CO_PURCHASE";

  @Column({ name: "positive_count", type: "integer", default: 0 })
  positiveCount!: number;

  @Column({ name: "negative_count", type: "integer", default: 0 })
  negativeCount!: number;

  @Column({ name: "relation_score", type: "double precision", default: 0 })
  relationScore!: number;

  @Column({ name: "last_signal_at", type: "timestamptz" })
  lastSignalAt!: Date;

  @Column({ name: "window_start", type: "timestamptz" })
  windowStart!: Date;

  @Column({ name: "window_end", type: "timestamptz" })
  windowEnd!: Date;

  @Column({ name: "updated_at", type: "timestamptz", default: () => "now()" })
  updatedAt!: Date;
}
