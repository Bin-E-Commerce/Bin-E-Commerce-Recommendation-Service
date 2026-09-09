import { MigrationInterface, QueryRunner } from "typeorm";

// Migration Phase 3 mở rộng catalog semantic fields và durable embedding job; không xóa dữ liệu Phase 2 khi rollback.
export class AddPhase3CatalogIntelligence1788024000000 implements MigrationInterface {
  name = "AddPhase3CatalogIntelligence1788024000000";

  // Tạo schema embedding độc lập để catalog event có thể retry mà không mất job.
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "recommendation_catalog_products" ALTER COLUMN "catalog_version" TYPE bigint USING "catalog_version"::bigint`);
    await queryRunner.query(`ALTER TABLE "recommendation_catalog_products" ADD COLUMN IF NOT EXISTS "short_description" text`);
    await queryRunner.query(`ALTER TABLE "recommendation_catalog_products" ADD COLUMN IF NOT EXISTS "description" text`);
    await queryRunner.query(`ALTER TABLE "recommendation_catalog_products" ADD COLUMN IF NOT EXISTS "brand_name" varchar(255)`);
    await queryRunner.query(`ALTER TABLE "recommendation_catalog_products" ADD COLUMN IF NOT EXISTS "category_path" text`);
    await queryRunner.query(`ALTER TABLE "recommendation_catalog_products" ADD COLUMN IF NOT EXISTS "semantic_attributes" jsonb NOT NULL DEFAULT '[]'::jsonb`);
    await queryRunner.query(`ALTER TABLE "recommendation_catalog_products" ADD COLUMN IF NOT EXISTS "content_hash" varchar(128)`);
    await queryRunner.query(`ALTER TABLE "recommendation_catalog_products" ADD COLUMN IF NOT EXISTS "embedding_status" varchar(16) NOT NULL DEFAULT 'NOT_REQUIRED'`);
    await queryRunner.query(`ALTER TABLE "recommendation_catalog_products" ADD COLUMN IF NOT EXISTS "embedding_model_version" varchar(128)`);
    await queryRunner.query(`ALTER TABLE "recommendation_catalog_products" ADD COLUMN IF NOT EXISTS "embedding_dimensions" integer`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_recommendation_catalog_embedding_status" ON "recommendation_catalog_products" ("embedding_status")`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "recommendation_embedding_jobs" (
        "job_id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "product_id" varchar(128) NOT NULL,
        "content_hash" varchar(128) NOT NULL,
        "embedding_profile" varchar(64) NOT NULL,
        "model_version" varchar(128) NOT NULL,
        "text_content" text NOT NULL,
        "status" varchar(16) NOT NULL DEFAULT 'PENDING',
        "attempt_count" integer NOT NULL DEFAULT 0,
        "leased_until" timestamptz,
        "available_at" timestamptz NOT NULL DEFAULT now(),
        "last_error_code" varchar(128),
        "last_error_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "completed_at" timestamptz,
        CONSTRAINT "PK_recommendation_embedding_jobs" PRIMARY KEY ("job_id"),
        CONSTRAINT "UQ_recommendation_embedding_job_content" UNIQUE ("product_id", "content_hash", "embedding_profile")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_recommendation_embedding_jobs_ready" ON "recommendation_embedding_jobs" ("status", "available_at")`);
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "recommendation_catalog_sync_checkpoints" ("sync_name" varchar(64) NOT NULL, "next_page" integer NOT NULL DEFAULT 1, "updated_at" timestamptz NOT NULL DEFAULT now(), CONSTRAINT "PK_recommendation_catalog_sync_checkpoints" PRIMARY KEY ("sync_name"))`);
  }

  // Chỉ rollback các cột/bảng Phase 3; catalog read model và profile Phase 2 vẫn được giữ nguyên.
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_recommendation_embedding_jobs_ready"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "recommendation_embedding_jobs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "recommendation_catalog_sync_checkpoints"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_recommendation_catalog_embedding_status"`);
    for (const column of ["embedding_dimensions", "embedding_model_version", "embedding_status", "content_hash", "semantic_attributes", "category_path", "brand_name", "description", "short_description"]) {
      await queryRunner.query(`ALTER TABLE "recommendation_catalog_products" DROP COLUMN IF EXISTS "${column}"`);
    }
    await queryRunner.query(`ALTER TABLE "recommendation_catalog_products" ALTER COLUMN "catalog_version" TYPE integer USING "catalog_version"::integer`);
  }
}
