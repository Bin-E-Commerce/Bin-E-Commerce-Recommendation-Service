import { MigrationInterface, QueryRunner } from "typeorm";

// Migration tạo read model độc lập cho relation consumer để không phụ thuộc thứ tự xử lý của interaction consumer.
export class CreateRecommendationRelationSignals1788031000000 implements MigrationInterface {
  name = "CreateRecommendationRelationSignals1788031000000";

  // Lưu những event cần tạo co-view/co-cart trong cùng transaction với relation projection.
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "recommendation_relation_signals" (
        "event_id" varchar(128) NOT NULL,
        "user_id" varchar(128),
        "session_id" varchar(128),
        "interaction_type" varchar(64) NOT NULL,
        "product_id" varchar(128) NOT NULL,
        "occurred_at" timestamptz NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_recommendation_relation_signals" PRIMARY KEY ("event_id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_recommendation_relation_signals_session_occurred"
      ON "recommendation_relation_signals" ("session_id", "occurred_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_recommendation_relation_signals_user_occurred"
      ON "recommendation_relation_signals" ("user_id", "occurred_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_recommendation_relation_signals_product_occurred"
      ON "recommendation_relation_signals" ("product_id", "occurred_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_recommendation_relation_signals_occurred"
      ON "recommendation_relation_signals" ("occurred_at")
    `);
  }

  // Chỉ xóa object do migration này sở hữu khi rollback.
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_recommendation_relation_signals_occurred"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_recommendation_relation_signals_product_occurred"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_recommendation_relation_signals_user_occurred"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_recommendation_relation_signals_session_occurred"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "recommendation_relation_signals"`);
  }
}
