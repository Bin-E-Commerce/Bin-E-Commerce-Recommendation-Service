// Migration này bổ sung index updated_at cho reconciliation/catalog freshness mà không sửa migration đã chạy ở môi trường cũ.

import { MigrationInterface, QueryRunner } from "typeorm";

export class AddRecommendationCatalogUpdatedIndex1788022000000 implements MigrationInterface {
  name = "AddRecommendationCatalogUpdatedIndex1788022000000";

  // Tạo index phục vụ đồng bộ catalog theo thay đổi gần nhất và các job reconciliation sau này.
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_recommendation_catalog_updated" ON "recommendation_catalog_products" ("updated_at")`,
    );
  }

  // Xóa đúng index do migration này sở hữu khi rollback, không ảnh hưởng các index catalog khác.
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_recommendation_catalog_updated"`,
    );
  }
}
