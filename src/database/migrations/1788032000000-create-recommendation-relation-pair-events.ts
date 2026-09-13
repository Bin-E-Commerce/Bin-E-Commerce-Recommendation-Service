import { MigrationInterface, QueryRunner } from "typeorm";

// Migration tạo pair-ledger để relation projection idempotent cả khi event đến sai thứ tự.
export class CreateRecommendationRelationPairEvents1788032000000 implements MigrationInterface {
  name = "CreateRecommendationRelationPairEvents1788032000000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "recommendation_relation_pair_events" (
        "first_event_id" varchar(128) NOT NULL,
        "second_event_id" varchar(128) NOT NULL,
        "relation_type" varchar(24) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_recommendation_relation_pair_events"
          PRIMARY KEY ("first_event_id", "second_event_id", "relation_type")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_recommendation_relation_pair_events_created"
      ON "recommendation_relation_pair_events" ("created_at")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_recommendation_relation_pair_events_created"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "recommendation_relation_pair_events"`);
  }
}
