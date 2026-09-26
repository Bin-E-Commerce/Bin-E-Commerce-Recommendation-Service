// Migration tạo event store cho impact analytics, giữ nguyên thời điểm xảy ra thay vì làm tròn về ngày.

import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateRecommendationPopularityEvents1788034000000 implements MigrationInterface {
    name = 'CreateRecommendationPopularityEvents1788034000000';

    // Lưu timestamp của purchase/return để phép so sánh có thể tách event xảy ra trước và sau thời điểm apply trong cùng một ngày.
    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "recommendation_product_popularity_events" (
        "event_id" varchar(128) NOT NULL,
        "product_id" varchar(128) NOT NULL,
        "occurred_at" timestamptz NOT NULL,
        "purchases" integer NOT NULL DEFAULT 0,
        "purchase_completed" integer NOT NULL DEFAULT 0,
        "purchase_returned" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_recommendation_product_popularity_events" PRIMARY KEY ("event_id", "product_id")
      )
    `);
        await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_recommendation_popularity_events_product_time"
      ON "recommendation_product_popularity_events" ("product_id", "occurred_at")
    `);
    }

    // Xoá index và bảng thuộc migration này khi rollback môi trường development.
    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_recommendation_popularity_events_product_time"
    `);
        await queryRunner.query(`
      DROP TABLE IF EXISTS "recommendation_product_popularity_events"
    `);
    }
}
