import { MigrationInterface, QueryRunner } from "typeorm";

// Migration tạo co-behavior read model độc lập với profile projection và có index phục vụ anchor lookup.
export class CreateRecommendationRelations1788025000000 implements MigrationInterface {
  name = "CreateRecommendationRelations1788025000000";

  // Tạo relation table/ledger và index interaction cho các cửa sổ thời gian bounded.
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_recommendation_interactions_session_window" ON "recommendation_interactions" ("session_id", "occurred_at", "interaction_type", "product_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_recommendation_interactions_user_window" ON "recommendation_interactions" ("user_id", "occurred_at", "interaction_type", "product_id")`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "recommendation_product_relations" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "source_product_id" varchar(128) NOT NULL,
        "target_product_id" varchar(128) NOT NULL,
        "relation_type" varchar(24) NOT NULL,
        "positive_count" integer NOT NULL DEFAULT 0,
        "negative_count" integer NOT NULL DEFAULT 0,
        "relation_score" double precision NOT NULL DEFAULT 0,
        "last_signal_at" timestamptz NOT NULL,
        "window_start" timestamptz NOT NULL,
        "window_end" timestamptz NOT NULL,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_recommendation_product_relations" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_recommendation_product_relation" UNIQUE ("source_product_id", "target_product_id", "relation_type")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_recommendation_product_relation_source" ON "recommendation_product_relations" ("source_product_id", "relation_type", "relation_score")`);
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "recommendation_relation_projection_events" ("event_id" varchar(128) NOT NULL, "projection_type" varchar(64) NOT NULL, "processed_at" timestamptz NOT NULL DEFAULT now(), CONSTRAINT "PK_recommendation_relation_projection_events" PRIMARY KEY ("event_id", "projection_type"))`);
  }

  // Rollback an toàn cho development, không đụng profile/interactions authoritative của Recommendation.
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "recommendation_relation_projection_events"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_recommendation_product_relation_source"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "recommendation_product_relations"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_recommendation_interactions_user_window"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_recommendation_interactions_session_window"`);
  }
}
