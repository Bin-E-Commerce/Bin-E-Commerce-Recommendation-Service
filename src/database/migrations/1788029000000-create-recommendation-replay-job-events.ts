import { MigrationInterface, QueryRunner } from "typeorm";

// Tạo event rows durable và lease columns để replay có thể resume, retry và chạy an toàn trên nhiều replica.
export class CreateRecommendationReplayJobEvents1788029000000 implements MigrationInterface {
  name = "CreateRecommendationReplayJobEvents1788029000000";

  // Payload chỉ được nhận qua internal endpoint có token và vẫn đi lại đúng Kafka business pipeline.
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE recommendation_replay_jobs
        ADD COLUMN IF NOT EXISTS available_at timestamptz NOT NULL DEFAULT now(),
        ADD COLUMN IF NOT EXISTS lease_until timestamptz
    `);
    await queryRunner.query(`
      UPDATE recommendation_replay_jobs
         SET status = 'PENDING', available_at = now(), lease_until = NULL, updated_at = now()
       WHERE status = 'PROCESSING'
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS recommendation_replay_job_events (
        event_row_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        job_id uuid NOT NULL REFERENCES recommendation_replay_jobs(job_id) ON DELETE CASCADE,
        sequence integer NOT NULL CHECK (sequence >= 0),
        event_id varchar(255) NOT NULL,
        payload jsonb NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'PENDING',
        attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        last_error varchar(255),
        published_at timestamptz,
        CONSTRAINT ck_recommendation_replay_job_events_status
          CHECK (status IN ('PENDING', 'PUBLISHED', 'FAILED')),
        CONSTRAINT uq_recommendation_replay_job_events_event
          UNIQUE (job_id, sequence)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_recommendation_replay_job_events_pending
      ON recommendation_replay_job_events (job_id, status, sequence)
    `);
  }

  // Xóa event rows trước rồi mới xóa columns bổ sung của job metadata.
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DROP TABLE IF EXISTS recommendation_replay_job_events");
    await queryRunner.query(`
      ALTER TABLE recommendation_replay_jobs
        DROP COLUMN IF EXISTS available_at,
        DROP COLUMN IF EXISTS lease_until
    `);
  }
}
