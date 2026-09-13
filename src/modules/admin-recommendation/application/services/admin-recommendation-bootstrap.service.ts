// Bootstrap này nạp policy active từ DB vào rule runtime khi service khởi động; không có record thì giữ env/default.

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RecommendationRuleService } from "../../../profiles/application/services/rules/recommendation-rule.service";
import { RecommendationAdminRepository } from "../../infrastructure/repositories/recommendation-admin.repository";

@Injectable()
export class AdminRecommendationBootstrapService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(
    AdminRecommendationBootstrapService.name,
  );
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly repository: RecommendationAdminRepository,
    private readonly rules: RecommendationRuleService,
    private readonly config: ConfigService,
  ) {}

  // Nạp policy trước khi request đầu tiên đến; lỗi DB vẫn để rule env hoạt động qua lifecycle TypeORM retry.
  async onModuleInit(): Promise<void> {
    await this.syncActivePolicy();
    const intervalMs = this.readIntervalMs();
    this.timer = setInterval(() => void this.syncActivePolicy(), intervalMs);
    // Không giữ Node process sống chỉ vì timer khi app đang shutdown hoặc test đã hoàn tất.
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // Poll nhẹ theo version để các instance khác nhận policy mới mà không cần restart hoặc đọc DB trong request recommendation.
  private async syncActivePolicy(): Promise<void> {
    try {
      const active = await this.repository.findActivePolicy();
      if (!active) {
        // Nếu record active bị xóa/disable, không giữ policy cũ trong memory của instance.
        this.rules.setRuntimePolicy(null);
        return;
      }
      if (active.version === this.rules.getPolicySnapshot().version) return;
      const config = active.config as {
        hybridWeights?: Record<string, number>;
        mlEnabled?: boolean;
        mlBlend?: number;
      };
      this.rules.setRuntimePolicy({
        version: active.version,
        hybridWeights: config.hybridWeights,
        mlEnabled: config.mlEnabled,
        mlBlend: config.mlBlend,
      });
    } catch (error) {
      // Policy đang chạy vẫn hợp lệ; lần poll kế tiếp sẽ tự retry khi DB tạm thời unavailable.
      this.logger.warn(
        `Recommendation policy sync deferred: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  // Giới hạn polling để config sai không tạo DB load bất thường trên nhiều instance.
  private readIntervalMs(): number {
    const value = Number(
      this.config.get<string>(
        "RECOMMENDATION_POLICY_SYNC_INTERVAL_MS",
        "30000",
      ),
    );
    return Number.isFinite(value)
      ? Math.min(Math.max(Math.trunc(value), 5000), 300000)
      : 30000;
  }
}
