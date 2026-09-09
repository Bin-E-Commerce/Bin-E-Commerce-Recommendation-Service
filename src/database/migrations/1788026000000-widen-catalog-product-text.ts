import { MigrationInterface, QueryRunner } from "typeorm";

// Đồng bộ giới hạn snapshot với Product Service để product name/slug hợp lệ không bị DLQ hoặc lỗi insert.
export class WidenCatalogProductText1788026000000 implements MigrationInterface {
  name = "WidenCatalogProductText1788026000000";

  // Mở rộng cột trước khi consumer nhận catalog event mới; không thay đổi dữ liệu semantic hiện có.
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "recommendation_catalog_products" ALTER COLUMN "name" TYPE varchar(500)`);
    await queryRunner.query(`ALTER TABLE "recommendation_catalog_products" ALTER COLUMN "slug" TYPE varchar(620)`);
  }

  // Rollback an toàn bằng cách cắt dữ liệu vượt giới hạn cũ trước khi thu hẹp cột.
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "recommendation_catalog_products" SET "name" = LEFT("name", 255), "slug" = LEFT("slug", 255) WHERE LENGTH("name") > 255 OR LENGTH("slug") > 255`);
    await queryRunner.query(`ALTER TABLE "recommendation_catalog_products" ALTER COLUMN "name" TYPE varchar(255)`);
    await queryRunner.query(`ALTER TABLE "recommendation_catalog_products" ALTER COLUMN "slug" TYPE varchar(255)`);
  }
}
