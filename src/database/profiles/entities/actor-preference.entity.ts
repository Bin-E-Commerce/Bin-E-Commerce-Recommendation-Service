// Entity này lưu điểm sở thích theo dimension để profile có thể query top category/brand/product mà không parse JSONB lớn.

import { Column, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from "typeorm";
import type { RecommendationActorType } from "./actor-profile.entity";

export type RecommendationPreferenceDimension = "PRODUCT" | "CATEGORY" | "BRAND" | "PRICE_BUCKET" | "QUERY";

@Entity("recommendation_actor_preferences")
@Unique("uq_recommendation_actor_preferences_key", ["actorType", "actorId", "dimension", "dimensionKey"])
@Index("idx_recommendation_actor_preferences_score", ["actorType", "actorId", "dimension", "score"])
@Index("idx_recommendation_actor_preferences_signal", ["actorType", "actorId", "lastSignalAt"])
export class RecommendationActorPreferenceEntity {
  // Khóa nội bộ của một preference row; identity nghiệp vụ nằm ở unique key bên dưới.
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  // Cho biết preference thuộc user hay guest session để không trộn dữ liệu giữa hai loại actor.
  @Column({ name: "actor_type", type: "varchar", length: 16 })
  actorType!: RecommendationActorType;

  // User ID hoặc session ID sở hữu tín hiệu sở thích này.
  @Column({ name: "actor_id", type: "varchar", length: 128 })
  actorId!: string;

  // Loại đối tượng được yêu thích, ví dụ product, category, brand, price bucket hoặc query.
  @Column({ type: "varchar", length: 24 })
  dimension!: RecommendationPreferenceDimension;

  // Khóa cụ thể trong dimension, chẳng hạn productId, categoryId, brandId hoặc nội dung query đã chuẩn hóa.
  @Column({ name: "dimension_key", type: "varchar", length: 255 })
  dimensionKey!: string;

  // Điểm sở thích tích lũy từ các behavior weight; ranking sẽ áp dụng decay theo lastSignalAt.
  @Column({ type: "double precision", default: 0 })
  score!: number;

  // Số event đã đóng góp vào preference, dùng đánh giá độ ổn định của tín hiệu bên cạnh score.
  @Column({ name: "interaction_count", type: "integer", default: 0 })
  interactionCount!: number;

  // Thời điểm tín hiệu cuối cùng tác động tới row; là mốc chính để giảm điểm theo thời gian.
  @Column({ name: "last_signal_at", type: "timestamptz" })
  lastSignalAt!: Date;

  // Thời điểm preference row được cập nhật, phục vụ audit và các job đồng bộ/cache sau này.
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
