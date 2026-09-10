import { MigrationInterface, QueryRunner } from "typeorm";

// Migration tạo metadata replay; payload bounded được bổ sung ở migration event rows kế tiếp để worker resume được.
export class CreateRecommendationReplayJobs1788028000000 implements MigrationInterface {
  name = "CreateRecommendationReplayJobs1788028000000";

  // Tạo bảng trạng thái replay để operator theo dõi tiến độ và lỗi publish.
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "CREATE TABLE IF NOT EXISTS recommendation_replay_jobs (" +
        "job_id uuid PRIMARY KEY DEFAULT gen_random_uuid()," +
        "source_topic varchar(200) NOT NULL," +
        "status varchar(16) NOT NULL DEFAULT 'PENDING'," +
        "total_count integer NOT NULL CHECK (total_count BETWEEN 0 AND 100)," +
        "published_count integer NOT NULL DEFAULT 0 CHECK (published_count >= 0)," +
        "failed_count integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0)," +
        "last_error varchar(255)," +
        "created_at timestamptz NOT NULL DEFAULT now()," +
        "updated_at timestamptz NOT NULL DEFAULT now()," +
        "completed_at timestamptz" +
      ")",
    );
    await queryRunner.query(
      "CREATE INDEX IF NOT EXISTS idx_recommendation_replay_jobs_created " +
        "ON recommendation_replay_jobs (created_at DESC)",
    );
  }

  // Xóa metadata replay khi rollback; không ảnh hưởng event hoặc read model nghiệp vụ.
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DROP INDEX IF EXISTS idx_recommendation_replay_jobs_created");
    await queryRunner.query("DROP TABLE IF EXISTS recommendation_replay_jobs");
  }
}
