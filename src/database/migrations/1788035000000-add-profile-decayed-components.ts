// Migration này thêm hai tổng sở thích đã decay; điểm cũ chỉ dùng khởi tạo gần đúng tại lastSignalAt.
// Những event lịch sử không còn timestamp trong aggregate cần replay nếu muốn tái dựng chính xác.

import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProfileDecayedComponents1788035000000 implements MigrationInterface {
    name = 'AddProfileDecayedComponents1788035000000';

    // Giữ score cũ để các bản ghi hiện hữu không mất tín hiệu khi chuyển sang cách tính mới.
    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            'ALTER TABLE "recommendation_actor_preferences" ADD COLUMN "positive_score" double precision NOT NULL DEFAULT 0',
        );
        await queryRunner.query(
            'ALTER TABLE "recommendation_actor_preferences" ADD COLUMN "negative_score" double precision NOT NULL DEFAULT 0',
        );
        await queryRunner.query(
            'UPDATE "recommendation_actor_preferences" SET "positive_score" = GREATEST("score", 0), "negative_score" = GREATEST(-"score", 0)',
        );
        await queryRunner.query(
            'CREATE INDEX "IDX_recommendation_profile_positive" ON "recommendation_actor_preferences" ("actor_type", "actor_id", "dimension", "positive_score" DESC)',
        );
        await queryRunner.query(
            'CREATE INDEX "IDX_recommendation_profile_negative" ON "recommendation_actor_preferences" ("actor_type", "actor_id", "dimension", "negative_score" DESC)',
        );
    }

    // Đảo migration chỉ xóa phần mới; score cũ vẫn tồn tại cho bản triển khai trước.
    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            'DROP INDEX "IDX_recommendation_profile_negative"',
        );
        await queryRunner.query(
            'DROP INDEX "IDX_recommendation_profile_positive"',
        );
        await queryRunner.query(
            'ALTER TABLE "recommendation_actor_preferences" DROP COLUMN "negative_score"',
        );
        await queryRunner.query(
            'ALTER TABLE "recommendation_actor_preferences" DROP COLUMN "positive_score"',
        );
    }
}
