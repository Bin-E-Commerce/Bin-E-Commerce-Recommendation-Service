// Migration bỏ metadata nguồn khỏi read model mà vẫn giữ catalog, tương tác và dữ liệu xếp hạng.
import { MigrationInterface, QueryRunner } from 'typeorm';

export class RemoveCrawledRecommendationData1788351000000 implements MigrationInterface {
    name = 'RemoveCrawledRecommendationData1788351000000';

    // Bỏ index/cột phân loại nhưng giữ catalog, tương tác, quan hệ và trace.
    // Embedding job, preference và popularity cũng được giữ nguyên.
    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            'DROP INDEX IF EXISTS "IDX_recommendation_catalog_origin"',
        );
        await queryRunner.query(`
            ALTER TABLE "recommendation_catalog_products"
            DROP COLUMN IF EXISTS "origin_type" CASCADE,
            DROP COLUMN IF EXISTS "external_shop_id" CASCADE
        `);
    }

    // Không thể phục hồi nguồn sản phẩm từ read model sau khi bỏ metadata.
    // Gán nguồn mặc định sẽ làm sai lệch dữ liệu nên migration bị khóa ngược.
    async down(_queryRunner: QueryRunner): Promise<void> {
        throw new Error(
            'Migration bỏ metadata nguồn recommendation là không thể rollback an toàn.',
        );
    }
}
