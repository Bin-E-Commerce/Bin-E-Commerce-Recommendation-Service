// Migration này tạo interaction read model độc lập, có unique event_id và index theo actor/product để phục vụ Phase 2.

import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateRecommendationInteractions1788020000000
  implements MigrationInterface
{
  name = "CreateRecommendationInteractions1788020000000";

  // Tạo bảng và constraint ở database để bảo vệ dữ liệu kể cả khi consumer bị redelivery hoặc bypass application.
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await queryRunner.query(`
      CREATE TABLE "recommendation_interactions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "event_id" varchar(128) NOT NULL,
        "event_name" varchar(128) NOT NULL,
        "event_version" integer NOT NULL,
        "source" varchar(128) NOT NULL,
        "occurred_at" timestamptz NOT NULL,
        "user_id" varchar(128),
        "session_id" varchar(128),
        "interaction_type" varchar(64) NOT NULL,
        "product_id" varchar(128),
        "variant_id" varchar(128),
        "category_id" varchar(128),
        "query" varchar(255),
        "page" varchar(80),
        "position" integer,
        "quantity" integer,
        "request_id" varchar(128),
        "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "processing_status" varchar(32) NOT NULL DEFAULT 'PROCESSED',
        "processing_error" text,
        "received_at" timestamptz NOT NULL DEFAULT now(),
        "processed_at" timestamptz,
        CONSTRAINT "PK_recommendation_interactions_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_recommendation_interactions_event_id" UNIQUE ("event_id"),
        CONSTRAINT "CHK_recommendation_interactions_actor" CHECK ("user_id" IS NOT NULL OR "session_id" IS NOT NULL),
        CONSTRAINT "CHK_recommendation_interactions_type" CHECK ("interaction_type" IN (
          'PRODUCT_VIEWED', 'PRODUCT_CLICKED', 'PRODUCT_IMPRESSED',
          'SEARCH_PERFORMED', 'PRODUCT_ADDED_TO_CART', 'PRODUCT_REMOVED_FROM_CART'
        )),
        CONSTRAINT "CHK_recommendation_interactions_position" CHECK ("position" IS NULL OR ("position" >= 0 AND "position" <= 1000)),
        CONSTRAINT "CHK_recommendation_interactions_quantity" CHECK ("quantity" IS NULL OR ("quantity" >= 1 AND "quantity" <= 10000)),
        CONSTRAINT "CHK_recommendation_interactions_status" CHECK ("processing_status" IN ('PROCESSED', 'FAILED'))
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_recommendation_interactions_user_occurred"
      ON "recommendation_interactions" ("user_id", "occurred_at")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_recommendation_interactions_session_occurred"
      ON "recommendation_interactions" ("session_id", "occurred_at")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_recommendation_interactions_product_occurred"
      ON "recommendation_interactions" ("product_id", "occurred_at")
    `);
  }

  // Xóa đúng các index/table do migration sở hữu khi rollback, không đụng vào database service khác.
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_recommendation_interactions_product_occurred"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_recommendation_interactions_session_occurred"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_recommendation_interactions_user_occurred"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "recommendation_interactions"`);
  }
}
