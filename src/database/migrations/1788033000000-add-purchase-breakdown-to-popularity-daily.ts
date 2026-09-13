// Migration bổ sung counter mua thành công/trả hàng để Admin phân tích đúng theo từng ngày.

import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPurchaseBreakdownToPopularityDaily1788033000000
  implements MigrationInterface
{
  name = "AddPurchaseBreakdownToPopularityDaily1788033000000";

  // Tách mua và trả khỏi purchases net để dashboard không mất thông tin khi hai nghiệp vụ xảy ra cùng ngày.
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "recommendation_product_popularity_daily"
        ADD COLUMN IF NOT EXISTS "purchase_completed" integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "purchase_returned" integer NOT NULL DEFAULT 0
    `);
  }

  // Xóa đúng hai counter do migration này sở hữu khi rollback môi trường development.
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "recommendation_product_popularity_daily"
        DROP COLUMN IF EXISTS "purchase_completed",
        DROP COLUMN IF EXISTS "purchase_returned"
    `);
  }
}
