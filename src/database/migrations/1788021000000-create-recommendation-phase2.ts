// Migration này tạo các read model Phase 2 do Recommendation Service sở hữu; không tạo foreign key sang service khác.

import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateRecommendationPhase21788021000000 implements MigrationInterface {
  name = "CreateRecommendationPhase21788021000000";

  // Tạo profile, catalog và popularity tables cùng các index phục vụ candidate/ranking.
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "recommendation_actor_profiles" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "actor_type" varchar(16) NOT NULL,
        "actor_id" varchar(128) NOT NULL,
        "last_interaction_at" timestamptz,
        "profile_version" integer NOT NULL DEFAULT 1,
        "merged_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_recommendation_actor_profiles" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_recommendation_actor_profiles_actor" UNIQUE ("actor_type", "actor_id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "recommendation_actor_preferences" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "actor_type" varchar(16) NOT NULL,
        "actor_id" varchar(128) NOT NULL,
        "dimension" varchar(24) NOT NULL,
        "dimension_key" varchar(255) NOT NULL,
        "score" double precision NOT NULL DEFAULT 0,
        "interaction_count" integer NOT NULL DEFAULT 0,
        "last_signal_at" timestamptz NOT NULL,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_recommendation_actor_preferences" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_recommendation_actor_preferences_key" UNIQUE ("actor_type", "actor_id", "dimension", "dimension_key")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "recommendation_catalog_products" (
        "product_id" varchar(128) NOT NULL,
        "origin_type" varchar(16) NOT NULL,
        "name" varchar(255) NOT NULL,
        "slug" varchar(255) NOT NULL,
        "image_url" text,
        "category_id" varchar(128),
        "brand_id" varchar(128),
        "seller_shop_id" varchar(128),
        "external_shop_id" varchar(128),
        "min_price" numeric(14,2) NOT NULL,
        "max_price" numeric(14,2) NOT NULL,
        "rating_avg" numeric(3,2),
        "review_count" integer NOT NULL DEFAULT 0,
        "total_sold" integer NOT NULL DEFAULT 0,
        "status" varchar(16) NOT NULL,
        "is_in_stock" boolean NOT NULL DEFAULT false,
        "created_at" timestamptz NOT NULL,
        "updated_at" timestamptz NOT NULL,
        "catalog_version" integer NOT NULL DEFAULT 1,
        CONSTRAINT "PK_recommendation_catalog_products" PRIMARY KEY ("product_id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_recommendation_catalog_status_stock" ON "recommendation_catalog_products" ("status", "is_in_stock")`);
    await queryRunner.query(`CREATE INDEX "IDX_recommendation_catalog_category" ON "recommendation_catalog_products" ("category_id", "status")`);
    await queryRunner.query(`CREATE INDEX "IDX_recommendation_catalog_brand" ON "recommendation_catalog_products" ("brand_id", "status")`);
    await queryRunner.query(`CREATE INDEX "IDX_recommendation_catalog_origin" ON "recommendation_catalog_products" ("origin_type", "status")`);
    await queryRunner.query(`CREATE INDEX "IDX_recommendation_catalog_created" ON "recommendation_catalog_products" ("created_at")`);
    await queryRunner.query(`
      CREATE TABLE "recommendation_product_popularity" (
        "product_id" varchar(128) NOT NULL,
        "views_1d" integer NOT NULL DEFAULT 0,
        "views_7d" integer NOT NULL DEFAULT 0,
        "clicks_1d" integer NOT NULL DEFAULT 0,
        "cart_adds_7d" integer NOT NULL DEFAULT 0,
        "purchases_30d" integer NOT NULL DEFAULT 0,
        "popularity_score" double precision NOT NULL DEFAULT 0,
        "calculated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_recommendation_product_popularity" PRIMARY KEY ("product_id")
      )
    `);
    await queryRunner.query(`CREATE TABLE "recommendation_projection_events" ("event_id" varchar(128) NOT NULL, "processed_at" timestamptz NOT NULL DEFAULT now(), CONSTRAINT "PK_recommendation_projection_events" PRIMARY KEY ("event_id"))`);
    await queryRunner.query(`ALTER TABLE "recommendation_interactions" ADD COLUMN "recommendation_request_id" varchar(128)`);
    await queryRunner.query(`ALTER TABLE "recommendation_interactions" ADD COLUMN "recommendation_item_id" varchar(128)`);
    await queryRunner.query(`ALTER TABLE "recommendation_interactions" ADD COLUMN "recommendation_source" varchar(80)`);
    await queryRunner.query(`ALTER TABLE "recommendation_interactions" ADD COLUMN "recommendation_rank" integer`);
    await queryRunner.query(`ALTER TABLE "recommendation_interactions" ADD COLUMN "surface" varchar(32)`);
  }

  // Xóa các bảng Phase 2 theo thứ tự an toàn khi rollback môi trường dev.
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "recommendation_interactions" DROP COLUMN IF EXISTS "surface"`);
    await queryRunner.query(`ALTER TABLE "recommendation_interactions" DROP COLUMN IF EXISTS "recommendation_rank"`);
    await queryRunner.query(`ALTER TABLE "recommendation_interactions" DROP COLUMN IF EXISTS "recommendation_source"`);
    await queryRunner.query(`ALTER TABLE "recommendation_interactions" DROP COLUMN IF EXISTS "recommendation_item_id"`);
    await queryRunner.query(`ALTER TABLE "recommendation_interactions" DROP COLUMN IF EXISTS "recommendation_request_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "recommendation_projection_events"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "recommendation_product_popularity"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_recommendation_catalog_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_recommendation_catalog_origin"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_recommendation_catalog_brand"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_recommendation_catalog_category"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_recommendation_catalog_status_stock"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "recommendation_catalog_products"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "recommendation_actor_preferences"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "recommendation_actor_profiles"`);
  }
}
