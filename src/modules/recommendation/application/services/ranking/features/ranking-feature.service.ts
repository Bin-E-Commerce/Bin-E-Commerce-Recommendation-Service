// File này chuyển profile, session và candidate attribution thành feature vector chuẩn hóa; không xếp hạng và không truy cập database.
// Mọi feature đều bounded trong [0, 1] để hybrid policy có thể cộng trọng số ổn định.

import { Injectable } from "@nestjs/common";
import type {
  PreferenceValue,
  SessionContext,
} from "../../../../../profiles/application/types/profile.types";
import { RecommendationRuleService } from "../../../../../profiles/application/services/rules/recommendation-rule.service";
import type {
  RankingFeatureVector,
  RecommendationCandidate,
} from "../../../types/ranking/ranking.types";

@Injectable()
export class RankingFeatureService {
  constructor(private readonly rules: RecommendationRuleService) {}

  // Tính các feature độc lập để hybrid ranker có thể normalize, log và kiểm thử từng thành phần.
  build(
    candidate: RecommendationCandidate,
    products: PreferenceValue[],
    categories: PreferenceValue[],
    brands: PreferenceValue[],
    context: SessionContext | null,
  ): RankingFeatureVector {
    const productPreference = this.findPreference(
      products,
      candidate.product.productId,
    );
    const categoryPreference = this.findPreference(
      categories,
      candidate.product.categoryId,
    );
    const brandPreference = this.findPreference(
      brands,
      candidate.product.brandId,
    );
    const contributions = candidate.contributions ?? [];
    const semantic = contributions
      .filter((item) => item.source === "SEMANTIC_SIMILARITY")
      .map((item) => this.normalizeSemantic(item.rawScore))
      .reduce((max, value) => Math.max(max, value), 0);
    const coBehavior = contributions
      .filter((item) => item.source === "CO_BEHAVIOR")
      .map((item) => this.normalizeRelation(item.rawScore, item.relationType))
      .reduce((max, value) => Math.max(max, value), 0);
    const profileProduct = this.positivePreferenceScore(productPreference);
    const profileCategory = this.positivePreferenceScore(categoryPreference);
    const profileBrand = this.positivePreferenceScore(brandPreference);
    const profileAffinity = this.clamp(
      profileProduct + profileCategory * 0.6 + profileBrand * 0.4,
    );
    const sessionContext = this.sessionScore(candidate, context);
    const popularity = this.clamp(
      Math.max(
        Math.log1p(Math.max(0, candidate.product.totalSold)) / 12,
        this.sourceRankScore(contributions, ["TRENDING", "BEST_SELLING"]),
      ),
    );
    const freshness = this.freshnessScore(candidate.product.createdAt);
    const quality = this.qualityScore(candidate);
    const exploration = this.explorationScore(candidate, profileAffinity);
    const negativePenalty = this.negativePenalty(
      productPreference,
      categoryPreference,
      brandPreference,
    );

    return {
      profileAffinity,
      sessionContext,
      semanticSimilarity: semantic,
      coBehavior,
      popularity,
      freshness,
      quality,
      exploration,
      negativePenalty,
    };
  }

  // Tính preference đã decay để tín hiệu mới có ảnh hưởng lớn hơn nhưng không vượt quá bound của ranker.
  private positivePreferenceScore(value: PreferenceValue | undefined): number {
    if (!value) return 0;
    const decayed = this.decayedPreferenceScore(value);
    return this.clamp(Math.max(0, decayed) / 8);
  }

  // Giữ negative preference thành penalty riêng để tín hiệu trả hàng không bị trộn với positive affinity.
  private negativePenalty(
    ...values: Array<PreferenceValue | undefined>
  ): number {
    const negative = values.reduce((sum, value) => {
      if (!value || value.score >= 0) return sum;
      return sum + Math.abs(this.decayedPreferenceScore(value)) / 8;
    }, 0);
    return Math.min(0.15, this.clamp(negative) * 0.15);
  }

  // Dùng chung decay cho positive và negative signal để return/refund cũ không phạt user vĩnh viễn.
  private decayedPreferenceScore(value: PreferenceValue): number {
    const ageDays = Math.max(
      0,
      (Date.now() - value.lastSignalAt.getTime()) / 86_400_000,
    );
    return (
      value.score * Math.pow(0.5, ageDays / this.rules.getProfileHalfLifeDays())
    );
  }

  // Session score ưu tiên category/brand gần đây nhưng vẫn bounded để không lấn át profile dài hạn.
  private sessionScore(
    candidate: RecommendationCandidate,
    context: SessionContext | null,
  ): number {
    if (!context) return 0;
    const categoryMatch =
      candidate.product.categoryId &&
      context.recentCategoryIds.includes(candidate.product.categoryId)
        ? 0.6
        : 0;
    const brandMatch =
      candidate.product.brandId &&
      context.recentBrandIds.includes(candidate.product.brandId)
        ? 0.25
        : 0;
    const anchorMatch = (candidate.contributions ?? []).some(
      (item) => item.anchorProductId === context.currentProductId,
    )
      ? 0.15
      : 0;
    return this.clamp(categoryMatch + brandMatch + anchorMatch);
  }

  // Semantic score của Qdrant đã là similarity; clamp để provider thay đổi không làm điểm vượt policy.
  private normalizeSemantic(rawScore: number): number {
    return this.clamp(Number.isFinite(rawScore) ? rawScore : 0);
  }

  // Relation score dùng scale theo loại quan hệ để purchase mạnh hơn view mà vẫn không vượt [0, 1].
  private normalizeRelation(
    rawScore: number,
    relationType?: "CO_VIEW" | "CO_CART" | "CO_PURCHASE",
  ): number {
    const scale = this.rules.getRelationScoreScale(relationType);
    const positive = Math.max(0, Number.isFinite(rawScore) ? rawScore : 0);
    return positive / (positive + scale);
  }

  // Source rank bổ sung tín hiệu cho các source catalog vốn chỉ có danh sách đã sắp xếp.
  private sourceRankScore(
    contributions: NonNullable<RecommendationCandidate["contributions"]>,
    sources: string[],
  ): number {
    return contributions
      .filter((item) => sources.includes(item.source))
      .map((item) => {
        const rank = item.sourceRank ?? 1;
        const size = Math.max(item.sourceSize ?? rank, 1);
        return this.clamp(1 - (rank - 1) / Math.max(size - 1, 1));
      })
      .reduce((max, value) => Math.max(max, value), 0);
  }

  // Freshness dùng bucket thời gian cố định để score ổn định và không bị sản phẩm mới áp đảo lâu dài.
  private freshnessScore(createdAt: Date): number {
    const ageDays = Math.max(
      0,
      (Date.now() - createdAt.getTime()) / 86_400_000,
    );
    if (ageDays <= 1) return 1;
    if (ageDays <= 7) return 0.8;
    if (ageDays <= 30) return 0.55;
    if (ageDays <= 90) return 0.3;
    return 0.1;
  }

  // Quality kết hợp rating, độ tin cậy review và stock; product không hợp lệ vẫn bị filtering loại trước đó.
  private qualityScore(candidate: RecommendationCandidate): number {
    const rating = this.clamp(Number(candidate.product.ratingAvg ?? 0) / 5);
    const reviews = this.clamp(
      Math.log1p(Math.max(0, candidate.product.reviewCount)) / Math.log1p(100),
    );
    return this.clamp(
      rating * 0.55 + reviews * 0.25 + (candidate.product.isInStock ? 0.2 : 0),
    );
  }

  // Exploration dành điểm cho item mới hoặc source explore khi candidate chưa có affinity mạnh.
  private explorationScore(
    candidate: RecommendationCandidate,
    profileAffinity: number,
  ): number {
    if (profileAffinity > 0.4) return 0;
    return candidate.sources.has("EXPLORE") || candidate.sources.has("NEWEST")
      ? 1
      : 0;
  }

  // Tìm preference theo dimension key mà không expose entity persistence ra ranker.
  private findPreference(
    values: PreferenceValue[],
    key: string | null,
  ): PreferenceValue | undefined {
    return key ? values.find((item) => item.dimensionKey === key) : undefined;
  }

  // Clamp tập trung giúp mọi feature và penalty giữ đúng invariant của weighted policy.
  private clamp(value: number): number {
    return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  }
}
