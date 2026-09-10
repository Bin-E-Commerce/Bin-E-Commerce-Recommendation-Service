// Maintenance service dọn raw interaction và aggregate quá hạn theo batch, không xóa profile state đang phục vụ người dùng.
// Service chỉ chạy khi bật cờ rõ ràng; mọi thao tác xóa đều bounded để không chiếm lock dài trong production.

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";

// Chạy retention định kỳ và có thể được gọi lại an toàn sau khi process restart.
@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  // Chỉ bật worker khi operator chủ động cấu hình, tránh xóa dữ liệu ngoài ý muốn ở local.
  onModuleInit(): void {
    if (
      this.config.get<string>("RECOMMENDATION_RETENTION_ENABLED", "false") !==
      "true"
    )
      return;
    const intervalMs = Number(
      this.config.get<string>(
        "RECOMMENDATION_RETENTION_INTERVAL_MS",
        "86400000",
      ),
    );
    this.timer = setInterval(
      () => void this.runOnce(),
      Math.max(60000, intervalMs),
    );
    void this.runOnce();
  }

  // Dừng timer để shutdown không tạo query mới trong lúc application đang đóng.
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // Xóa raw event và daily aggregate theo retention, giữ projection ledger/profile để không làm mất idempotency state.
  async runOnce(): Promise<void> {
    if (this.running || !this.dataSource.isInitialized) return;
    this.running = true;
    let lockAcquired = false;
    try {
      const lockResult = (await this.dataSource.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
        ["recommendation-retention"],
      )) as Array<{ acquired: boolean }>;
      lockAcquired = lockResult[0]?.acquired === true;
      if (!lockAcquired) return;
      // Relation projector có consumer group riêng; giữ thêm safety window để không xóa interaction khi relation còn lag.
      const rawDays = Math.max(
        this.readPositiveInt("RECOMMENDATION_RAW_RETENTION_DAYS", 90),
        this.readPositiveInt("RECOMMENDATION_RELATION_SAFETY_DAYS", 7),
      );
      const aggregateDays = this.readPositiveInt(
        "RECOMMENDATION_AGGREGATE_RETENTION_DAYS",
        365,
      );
      const embeddingJobDays = this.readPositiveInt(
        "RECOMMENDATION_EMBEDDING_JOB_RETENTION_DAYS",
        90,
      );
      const replayJobDays = this.readPositiveInt(
        "RECOMMENDATION_REPLAY_JOB_RETENTION_DAYS",
        30,
      );
      const batchSize = Math.min(
        this.readPositiveInt("RECOMMENDATION_RETENTION_BATCH_SIZE", 1000),
        10000,
      );
      await this.deleteInteractions(rawDays, batchSize);
      await this.dataSource.query(
        "DELETE FROM recommendation_product_popularity_daily " +
          "WHERE bucket_date < CURRENT_DATE - ($1::int * INTERVAL '1 day')",
        [aggregateDays],
      );
      await this.dataSource.query(
        "DELETE FROM recommendation_embedding_jobs " +
          "WHERE status IN ('COMPLETED', 'FAILED', 'SUPERSEDED') " +
          "AND updated_at < NOW() - ($1::int * INTERVAL '1 day') " +
          "AND NOT EXISTS (" +
          "  SELECT 1 FROM recommendation_catalog_products product " +
          "  WHERE product.product_id = recommendation_embedding_jobs.product_id " +
          "    AND product.content_hash = recommendation_embedding_jobs.content_hash " +
          "    AND product.embedding_model_version = recommendation_embedding_jobs.model_version " +
          "    AND product.embedding_status = 'READY'" +
          ")",
        [embeddingJobDays],
      );
      await this.dataSource.query(
        "DELETE FROM recommendation_replay_jobs " +
          "WHERE status IN ('COMPLETED', 'FAILED') " +
          "AND updated_at < NOW() - ($1::int * INTERVAL '1 day')",
        [replayJobDays],
      );
    } catch (error) {
      this.logger.warn(
        "Recommendation retention deferred: " +
          (error instanceof Error ? error.message : "unknown"),
      );
    } finally {
      if (lockAcquired) {
        await this.dataSource
          .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
            "recommendation-retention",
          ])
          .catch(() => undefined);
      }
      this.running = false;
    }
  }

  // Xóa interaction theo ctid batch để mỗi transaction ngắn và giảm lock contention với profile/relation projector.
  private async deleteInteractions(
    days: number,
    batchSize: number,
  ): Promise<void> {
    while (true) {
      const rows = (await this.dataSource.query(
        "WITH expired AS (" +
          " SELECT ctid FROM recommendation_interactions" +
          " WHERE occurred_at < NOW() - ($1::int * INTERVAL '1 day')" +
          " ORDER BY occurred_at ASC LIMIT $2" +
          ") DELETE FROM recommendation_interactions interaction" +
          " USING expired WHERE interaction.ctid = expired.ctid" +
          " RETURNING interaction.event_id",
        [days, batchSize],
      )) as Array<{ event_id: string }>;
      if (rows.length < batchSize) break;
    }
  }

  // Chuẩn hóa config số nguyên để operator nhập sai không biến retention thành truy vấn nguy hiểm.
  private readPositiveInt(key: string, fallback: number): number {
    const value = Number(this.config.get<string>(key, String(fallback)));
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }
}
