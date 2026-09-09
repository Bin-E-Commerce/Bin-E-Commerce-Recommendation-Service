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

export interface HybridRankingWeights {
  profileAffinity: number;
  sessionContext: number;
  semanticSimilarity: number;
  coBehavior: number;
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

const DEFAULT_HYBRID_RANKING_WEIGHTS: HybridRankingWeights = {
  profileAffinity: 0.25,
  sessionContext: 0.18,
  semanticSimilarity: 0.15,
  coBehavior: 0.1,
  popularity: 0.12,
  freshness: 0.08,
  quality: 0.08,
  exploration: 0.04,
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
    const weight =
      configured === undefined ? defaultWeight : Number(configured);
    const hasExpectedSign =
      defaultWeight === 0 || Math.sign(weight) === Math.sign(defaultWeight);
    return Number.isFinite(weight) && hasExpectedSign ? weight : defaultWeight;
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
    return this.config.get<string>(
      "RECOMMENDATION_RULE_VERSION",
      "control-ranking-v2",
    );
  }

  // Đọc trọng số ranking từ config và normalize về tổng 1 để thay policy không cần sửa business logic.
  getRankingWeights(): RecommendationRankingWeights {
    const values = Object.fromEntries(
      Object.entries(DEFAULT_RANKING_WEIGHTS).map(([name, defaultValue]) => {
        const configName = name
          .replace(/[A-Z]/g, (letter) => `_${letter}`)
          .toUpperCase();
        const configured = Number(
          this.config.get<string>(
            `RECOMMENDATION_RANKING_WEIGHT_${configName}`,
            String(defaultValue),
          ),
        );
        return [
          name,
          Number.isFinite(configured) && configured >= 0
            ? configured
            : defaultValue,
        ];
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

  // Đọc policy Phase 4 từ config và normalize tổng weight về 1 để thay đổi trọng số không cần sửa business logic.
  getHybridRankingWeights(): HybridRankingWeights {
    const values = Object.fromEntries(
      Object.entries(DEFAULT_HYBRID_RANKING_WEIGHTS).map(
        ([name, defaultValue]) => {
          const configName = name
            .replace(/[A-Z]/g, (letter) => `_${letter}`)
            .toUpperCase();
          const configured = Number(
            this.config.get<string>(
              `RECOMMENDATION_HYBRID_RANKING_WEIGHT_${configName}`,
              String(defaultValue),
            ),
          );
          return [
            name,
            Number.isFinite(configured) && configured >= 0
              ? configured
              : defaultValue,
          ];
        },
      ),
    ) as HybridRankingWeights;
    const total = Object.values(values).reduce((sum, value) => sum + value, 0);
    if (total <= 0) return DEFAULT_HYBRID_RANKING_WEIGHTS;
    return Object.fromEntries(
      Object.entries(values).map(([name, value]) => [name, value / total]),
    ) as unknown as HybridRankingWeights;
  }

  // Kiểm tra feature flag ở một nơi duy nhất để control ranking luôn có đường fallback rõ ràng.
  isHybridRankingEnabled(): boolean {
    return (
      this.config.get<string>("RANKING_PIPELINE_V4_ENABLED", "false") ===
        "true" &&
      this.config.get<string>("HYBRID_RANKING_ENABLED", "false") === "true"
    );
  }

  // Trả version policy để cache và analytics không trộn kết quả giữa control và hybrid.
  getHybridPolicyVersion(): string {
    return this.config.get<string>(
      "RECOMMENDATION_RANKING_POLICY_VERSION",
      "hybrid-ranking-v1",
    );
  }

  // Relation scale cấu hình được để purchase/cart/view có ảnh hưởng khác nhau mà không hard-code trong ranker.
  getRelationScoreScale(
    relationType?: "CO_VIEW" | "CO_CART" | "CO_PURCHASE",
  ): number {
    const defaults = { CO_VIEW: 1, CO_CART: 3, CO_PURCHASE: 6 };
    const key = relationType ?? "CO_VIEW";
    const value = Number(
      this.config.get<string>(
        `RECOMMENDATION_RELATION_SCALE_${key}`,
        String(defaults[key]),
      ),
    );
    return Number.isFinite(value) && value > 0 ? value : defaults[key];
  }

  // Trả quota diversity theo surface; detail dùng quota nhỏ hơn nhưng vẫn giữ cùng invariant với home.
  getDiversityLimits(
    surface: "home" | "product_detail" | "recommendations_page",
  ) {
    return surface === "product_detail"
      ? { category: 2, brand: 2, shop: 3, windowSize: 6 }
      : { category: 4, brand: 3, shop: 5, windowSize: 24 };
  }
}
