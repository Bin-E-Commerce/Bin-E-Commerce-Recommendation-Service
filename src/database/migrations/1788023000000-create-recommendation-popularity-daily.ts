// Migration này tạo daily popularity buckets; bảng aggregate cũ vẫn được giữ để rollback và tương thích dữ liệu Phase 2.

import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateRecommendationPopularityDaily1788023000000 implements MigrationInterface {
  name = "CreateRecommendationPopularityDaily1788023000000";

  // Tạo khóa kép product/day để mỗi event chỉ cập nhật đúng một bucket rolling window.
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "recommendation_product_popularity_daily" (
        "product_id" varchar(128) NOT NULL,
        "bucket_date" date NOT NULL,
        "views" integer NOT NULL DEFAULT 0,
        "clicks" integer NOT NULL DEFAULT 0,
        "cart_adds" integer NOT NULL DEFAULT 0,
        "purchases" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_recommendation_product_popularity_daily" PRIMARY KEY ("product_id", "bucket_date")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_recommendation_popularity_daily_bucket" ON "recommendation_product_popularity_daily" ("bucket_date")`,
    );
  }

  // Xóa index và bảng theo thứ tự an toàn khi rollback môi trường development.
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_recommendation_popularity_daily_bucket"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "recommendation_product_popularity_daily"`,
    );
  }
}
