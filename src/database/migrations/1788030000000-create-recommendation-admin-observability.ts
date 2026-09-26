// Migration này tạo read model cho Admin analytics, immutable request trace và versioned ranking policy.

import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateRecommendationAdminObservability1788030000000 implements MigrationInterface {
    name = 'CreateRecommendationAdminObservability1788030000000';

    // Tạo bảng độc lập trong Recommendation DB, không tạo foreign key sang User/Product/Order service.
    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "recommendation_request_traces" (
        "request_id" varchar(128) NOT NULL,
        "actor_user_id" varchar(128),
        "actor_session_id" varchar(128),
        "surface" varchar(32) NOT NULL,
        "product_id" varchar(128),
        "strategy" varchar(32) NOT NULL,
        "policy_version" varchar(128) NOT NULL,
        "experiment_id" varchar(128),
        "experiment_variant" varchar(32),
        "candidate_count" integer NOT NULL DEFAULT 0,
        "ranked_count" integer NOT NULL DEFAULT 0,
        "items" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "formula" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "cache_hit" boolean NOT NULL DEFAULT false,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_recommendation_request_traces" PRIMARY KEY ("request_id")
      )
    `);
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_recommendation_request_traces_actor_created" ON "recommendation_request_traces" ("actor_user_id", "created_at")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_recommendation_request_traces_surface_created" ON "recommendation_request_traces" ("surface", "created_at")`,
        );

        await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "recommendation_policies" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "version" varchar(128) NOT NULL,
        "status" varchar(16) NOT NULL DEFAULT 'ACTIVE',
        "config" jsonb NOT NULL,
        "created_by" varchar(128),
        "reason" varchar(500),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_recommendation_policies" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_recommendation_policies_version" UNIQUE ("version")
      )
    `);
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_recommendation_policies_status_created" ON "recommendation_policies" ("status", "created_at")`,
        );
        await queryRunner.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_recommendation_policies_single_active" ON "recommendation_policies" ("status") WHERE "status" = 'ACTIVE'`,
        );
    }

    // Xóa đúng các bảng do migration này sở hữu, không đụng interaction/catalog read model.
    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `DROP INDEX IF EXISTS "UQ_recommendation_policies_single_active"`,
        );
        await queryRunner.query(
            `DROP INDEX IF EXISTS "IDX_recommendation_policies_status_created"`,
        );
        await queryRunner.query(
            `DROP TABLE IF EXISTS "recommendation_policies"`,
        );
        await queryRunner.query(
            `DROP INDEX IF EXISTS "IDX_recommendation_request_traces_surface_created"`,
        );
        await queryRunner.query(
            `DROP INDEX IF EXISTS "IDX_recommendation_request_traces_actor_created"`,
        );
        await queryRunner.query(
            `DROP TABLE IF EXISTS "recommendation_request_traces"`,
        );
    }
}
