// File này phân bổ actor vào ranking variant một cách deterministic; không lưu identity mới và không thay authorization của Gateway.

import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export type RankingExperimentVariant = "CONTROL" | "HYBRID";

@Injectable()
export class RankingExperimentService {
  constructor(private readonly config: ConfigService) {}

  // Giữ actor ở cùng variant giữa các request để metrics không bị nhiễu bởi random assignment.
  resolve(
    actorType: "USER" | "SESSION",
    actorId: string,
  ): {
    id: string | null;
    variant: RankingExperimentVariant;
  } {
    const enabled =
      this.config.get<string>("RANKING_EXPERIMENT_ENABLED", "false") === "true";
    const experimentId = this.config.get<string>(
      "RANKING_EXPERIMENT_ID",
      "recommendation-ranking-hybrid",
    );
    const traffic = this.clampPercent(
      Number(
        this.config.get<string>("RANKING_EXPERIMENT_TRAFFIC_PERCENT", "0"),
      ),
    );
    if (!enabled || traffic === 0) return { id: null, variant: "CONTROL" };
    const bucket = this.hash(`${experimentId}:${actorType}:${actorId}`) % 100;
    return {
      id: experimentId,
      variant: bucket < traffic ? "HYBRID" : "CONTROL",
    };
  }

  // FNV-1a đủ ổn định cho assignment, không dùng cho bảo mật hoặc authorization.
  private hash(value: string): number {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  // Giới hạn traffic về [0, 100] để config lỗi không vô tình bật toàn bộ treatment.
  private clampPercent(value: number): number {
    return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
  }
}
