// Migration tạo kho snapshot point-in-time; event impression/click tiếp tục ở bảng hiện hữu và nối qua request_id.

import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateRecommendationTrainingSnapshots1788036000000 implements MigrationInterface {
    name = 'CreateRecommendationTrainingSnapshots1788036000000';

    // Lưu feature input và provenance của candidate pool trong cùng request group, không sao chép danh tính actor.
    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
      CREATE TABLE "recommendation_training_snapshots" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "request_id" varchar(128) NOT NULL,
        "served_at" timestamptz NOT NULL,
        "features_computed_at" timestamptz NOT NULL,
        "environment" varchar(32) NOT NULL,
        "surface" varchar(32) NOT NULL,
        "page" integer NOT NULL,
        "strategy" varchar(32) NOT NULL,
        "ranking_mode" varchar(24) NOT NULL,
        "ranking_model_version" varchar(128),
        "ranking_policy_version" varchar(64) NOT NULL,
        "feature_schema_version" varchar(64) NOT NULL,
        "candidate_budget" integer NOT NULL,
        "candidate_count" integer NOT NULL,
        "selected_candidate_count" integer NOT NULL,
        "source_candidates" jsonb NOT NULL,
        "candidates" jsonb NOT NULL,
        "captured_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_recommendation_training_snapshots_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_recommendation_training_snapshots_request" UNIQUE ("request_id"),
        CONSTRAINT "CHK_recommendation_training_snapshots_surface" CHECK ("surface" IN ('home', 'product_detail', 'recommendations_page')),
        CONSTRAINT "CHK_recommendation_training_snapshots_strategy" CHECK ("strategy" IN ('PERSONALIZED', 'SESSION_BASED', 'COLD_START')),
        CONSTRAINT "CHK_recommendation_training_snapshots_mode" CHECK ("ranking_mode" = 'AI_MODEL'),
        CONSTRAINT "CHK_recommendation_training_snapshots_page" CHECK ("page" >= 1),
        CONSTRAINT "CHK_recommendation_training_snapshots_candidate_counts" CHECK (
          "candidate_budget" BETWEEN 1 AND 300 AND
          "candidate_count" BETWEEN 0 AND "candidate_budget" AND
          "selected_candidate_count" BETWEEN 0 AND 180 AND
          "selected_candidate_count" <= "candidate_count"
        ),
        CONSTRAINT "CHK_recommendation_training_snapshots_json_arrays" CHECK (
          jsonb_typeof("source_candidates") = 'array' AND
          jsonb_typeof("candidates") = 'array'
        )
      )
    `);
        await queryRunner.query(`
      CREATE INDEX "IDX_recommendation_training_snapshots_served_at"
      ON "recommendation_training_snapshots" ("served_at")
    `);
        await queryRunner.query(`
      CREATE INDEX "IDX_recommendation_training_snapshots_surface_served_at"
      ON "recommendation_training_snapshots" ("surface", "served_at")
    `);
        await queryRunner.query(`
      CREATE INDEX "IDX_recommendation_training_snapshots_model_served_at"
      ON "recommendation_training_snapshots" ("ranking_model_version", "served_at")
    `);
    }

    // Rollback chỉ xóa bảng và index mới thuộc snapshot, không đụng event history hiện hữu.
    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            'DROP INDEX IF EXISTS "IDX_recommendation_training_snapshots_model_served_at"',
        );
        await queryRunner.query(
            'DROP INDEX IF EXISTS "IDX_recommendation_training_snapshots_surface_served_at"',
        );
        await queryRunner.query(
            'DROP INDEX IF EXISTS "IDX_recommendation_training_snapshots_served_at"',
        );
        await queryRunner.query(
            'DROP TABLE IF EXISTS "recommendation_training_snapshots"',
        );
    }
}
