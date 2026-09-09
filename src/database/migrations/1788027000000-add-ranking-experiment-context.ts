import { MigrationInterface, QueryRunner } from "typeorm";

// Migration này lưu attribution của ranking policy để đo A/B mà không thay đổi interaction cũ.
export class AddRankingExperimentContext1788027000000
  implements MigrationInterface
{
  name = "AddRankingExperimentContext1788027000000";

  // Thêm các cột nullable để event cũ và interaction ngoài recommendation vẫn tương thích.
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "recommendation_interactions" ADD COLUMN IF NOT EXISTS "recommendation_policy_version" varchar(64)`,
    );
    await queryRunner.query(
      `ALTER TABLE "recommendation_interactions" ADD COLUMN IF NOT EXISTS "recommendation_experiment_id" varchar(128)`,
    );
    await queryRunner.query(
      `ALTER TABLE "recommendation_interactions" ADD COLUMN IF NOT EXISTS "recommendation_experiment_variant" varchar(16)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_recommendation_interactions_experiment" ON "recommendation_interactions" ("recommendation_experiment_id", "recommendation_experiment_variant", "occurred_at")`,
    );
  }

  // Rollback chỉ gỡ schema attribution do migration này sở hữu.
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_recommendation_interactions_experiment"`,
    );
    await queryRunner.query(
      `ALTER TABLE "recommendation_interactions" DROP COLUMN IF EXISTS "recommendation_experiment_variant"`,
    );
    await queryRunner.query(
      `ALTER TABLE "recommendation_interactions" DROP COLUMN IF EXISTS "recommendation_experiment_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "recommendation_interactions" DROP COLUMN IF EXISTS "recommendation_policy_version"`,
    );
  }
}
