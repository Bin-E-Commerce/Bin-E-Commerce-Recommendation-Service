// Entity này lưu trạng thái tổng hợp của user hoặc guest session; không chứa PII và không thay thế interaction ledger.

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

export type RecommendationActorType = "USER" | "SESSION";

@Entity("recommendation_actor_profiles")
@Index("uq_recommendation_actor_profiles_actor", ["actorType", "actorId"], { unique: true })
export class RecommendationActorProfileEntity {
  // Khóa nội bộ của profile record, không phải user ID và không dùng để định danh actor ở API.
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  // Phân biệt profile user đã đăng nhập với profile session của guest để áp dụng đúng chính sách merge.
  @Column({ name: "actor_type", type: "varchar", length: 16 })
  actorType!: RecommendationActorType;

  // User ID hoặc guest session ID tương ứng với actorType; cặp actorType + actorId là duy nhất.
  @Column({ name: "actor_id", type: "varchar", length: 128 })
  actorId!: string;

  // Lần tương tác gần nhất của actor, dùng nhận diện profile mới/cũ và ưu tiên tín hiệu còn hiệu lực.
  @Column({ name: "last_interaction_at", type: "timestamptz", nullable: true })
  lastInteractionAt!: Date | null;

  // Số phiên bản profile, tăng sau projection/merge để theo dõi thay đổi và hỗ trợ cache invalidation về sau.
  @Column({ name: "profile_version", type: "integer", default: 1 })
  profileVersion!: number;

  // Thời điểm session guest đã được merge vào user; có giá trị thì merge lặp lại phải trở thành no-op.
  @Column({ name: "merged_at", type: "timestamptz", nullable: true })
  mergedAt!: Date | null;

  // Thời điểm record được tạo lần đầu, phục vụ audit vòng đời profile.
  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  // Thời điểm profile hoặc trạng thái merge được cập nhật gần nhất.
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
