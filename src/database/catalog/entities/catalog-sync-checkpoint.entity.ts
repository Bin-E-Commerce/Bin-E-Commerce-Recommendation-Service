import { Column, Entity, PrimaryColumn, UpdateDateColumn } from "typeorm";

// Checkpoint durable cho catalog snapshot backfill; restart không phải quay lại toàn bộ page đã xử lý.
@Entity("recommendation_catalog_sync_checkpoints")
export class RecommendationCatalogSyncCheckpointEntity {
  @PrimaryColumn({ name: "sync_name", type: "varchar", length: 64 })
  syncName!: string;

  @Column({ name: "next_page", type: "integer", default: 1 })
  nextPage!: number;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
