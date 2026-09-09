import { MigrationInterface, QueryRunner } from "typeorm";

// Migration lưu user đích của guest session để interaction đến trễ sau login không bị mất khỏi profile user.
export class AddGuestMergeTarget1788025000000 implements MigrationInterface {
  name = "AddGuestMergeTarget1788025000000";

  // Thêm nullable column, không ảnh hưởng các session chưa merge và tương thích dữ liệu Phase 2/3.
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "recommendation_actor_profiles"
       ADD COLUMN IF NOT EXISTS "merged_user_id" varchar(128)`,
    );
  }

  // Xóa metadata merge khi rollback mà không xóa profile/session record.
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "recommendation_actor_profiles"
       DROP COLUMN IF EXISTS "merged_user_id"`,
    );
  }
}
