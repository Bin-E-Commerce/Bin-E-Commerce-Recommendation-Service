// Application worker điều phối retention theo config; không biết SQL, entity hay connection lifecycle.

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RetentionRepository } from "../../../infrastructure/repositories/retention.repository";

@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly repository: RetentionRepository,
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
      Number.isFinite(intervalMs) ? Math.max(60000, intervalMs) : 86400000,
    );
    void this.runOnce();
  }

  // Dừng timer để shutdown không tạo query mới trong lúc application đang đóng.
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // Đọc policy một lần rồi giao cleanup cho repository; running guard ngăn hai vòng cleanup trong cùng process.
  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const completed = await this.repository.run({
        rawDays: Math.max(
          this.readPositiveInt("RECOMMENDATION_RAW_RETENTION_DAYS", 90),
          this.readPositiveInt("RECOMMENDATION_RELATION_SAFETY_DAYS", 7),
        ),
        aggregateDays: this.readPositiveInt(
          "RECOMMENDATION_AGGREGATE_RETENTION_DAYS",
          365,
        ),
        embeddingJobDays: this.readPositiveInt(
          "RECOMMENDATION_EMBEDDING_JOB_RETENTION_DAYS",
          90,
        ),
        replayJobDays: this.readPositiveInt(
          "RECOMMENDATION_REPLAY_JOB_RETENTION_DAYS",
          30,
        ),
        batchSize: Math.min(
          this.readPositiveInt("RECOMMENDATION_RETENTION_BATCH_SIZE", 1000),
          10000,
        ),
      });
      if (!completed) this.logger.debug("Recommendation retention skipped");
    } catch (error) {
      this.logger.warn(
        "Recommendation retention deferred: " +
          (error instanceof Error ? error.message : "unknown"),
      );
    } finally {
      this.running = false;
    }
  }

  // Chuẩn hóa config số nguyên để operator nhập sai không biến retention thành truy vấn nguy hiểm.
  private readPositiveInt(key: string, fallback: number): number {
    const value = Number(this.config.get<string>(key, String(fallback)));
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }
}
