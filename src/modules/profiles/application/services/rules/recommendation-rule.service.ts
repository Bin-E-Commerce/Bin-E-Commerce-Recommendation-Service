// Service này tập trung weight/decay/rule version để ranking và profile projection dùng cùng một policy có thể cấu hình.

import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

const DEFAULT_WEIGHTS: Record<string, number> = {
  PRODUCT_IMPRESSED: 0.05,
  PRODUCT_VIEWED: 1,
  PRODUCT_CLICKED: 2,
  SEARCH_PERFORMED: 1.5,
  PRODUCT_ADDED_TO_CART: 4,
  PRODUCT_REMOVED_FROM_CART: -2,
};

export interface RecommendationRankingWeights {
  profileAffinity: number;
  sessionContext: number;
  popularity: number;
  freshness: number;
  quality: number;
  exploration: number;
}

const DEFAULT_RANKING_WEIGHTS: RecommendationRankingWeights = {
  profileAffinity: 0.35,
  sessionContext: 0.2,
  popularity: 0.15,
  freshness: 0.1,
  quality: 0.1,
  exploration: 0.1,
};

@Injectable()
export class RecommendationRuleService {
  constructor(private readonly config: ConfigService) {}

  // Trả weight ổn định cho projection; config sai hoặc thiếu sẽ dùng default an toàn.
  getInteractionWeight(interactionType: string): number {
    const configured = this.config.get<string>(
      `RECOMMENDATION_WEIGHT_${interactionType}`,
    );
    const defaultWeight = DEFAULT_WEIGHTS[interactionType] ?? 0;
    const weight = configured === undefined ? defaultWeight : Number(configured);
    return Number.isFinite(weight) ? weight : defaultWeight;
  }

  // Half-life dài hạn của profile được giới hạn dương để tránh decay sai hoặc score vô hạn.
  getProfileHalfLifeDays(): number {
    const value = Number(
      this.config.get<string>("RECOMMENDATION_PROFILE_HALF_LIFE_DAYS", "7"),
    );
    return Number.isFinite(value) && value > 0 ? value : 7;
  }

  // Rule version đi cùng response/cache giúp phân biệt kết quả sinh bởi policy nào khi deploy thay đổi trọng số.
  getRuleVersion(): string {
    return this.config.get<string>("RECOMMENDATION_RULE_VERSION", "phase2-rule-v2");
  }

  // Đọc trọng số ranking từ config và normalize về tổng 1 để thay policy không cần sửa business logic.
  getRankingWeights(): RecommendationRankingWeights {
    const values = Object.fromEntries(
      Object.entries(DEFAULT_RANKING_WEIGHTS).map(([name, defaultValue]) => {
        const configName = name.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase();
        const configured = Number(this.config.get<string>(`RECOMMENDATION_RANKING_WEIGHT_${configName}`, String(defaultValue)));
        return [name, Number.isFinite(configured) && configured >= 0 ? configured : defaultValue];
      }),
    ) as RecommendationRankingWeights;
    const total = Object.values(values).reduce((sum, value) => sum + value, 0);
    if (total <= 0) return DEFAULT_RANKING_WEIGHTS;
    return {
      profileAffinity: values.profileAffinity / total,
      sessionContext: values.sessionContext / total,
      popularity: values.popularity / total,
      freshness: values.freshness / total,
      quality: values.quality / total,
      exploration: values.exploration / total,
    };
  }
}
