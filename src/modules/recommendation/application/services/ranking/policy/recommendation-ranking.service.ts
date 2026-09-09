// File này là facade ranking cho Recommendation Service, giữ control Phase 2 và hybrid Phase 4 cùng một boundary.
// Candidate generation không nằm trong file này; service chỉ chấm điểm, diversity và trả kết quả deterministic.

import { Injectable } from "@nestjs/common";
import type { RecommendationCatalogProduct } from "../../../../../catalog/application/types/catalog-product.type";
import { RecommendationRuleService } from "../../../../../profiles/application/services/rules/recommendation-rule.service";
import type {
  PreferenceValue,
  SessionContext,
} from "../../../../../profiles/application/types/profile.types";
import type {
  RecommendationStrategy,
  RecommendationSurface,
} from "../../../types/recommendation.types";
import { RankingFeatureService } from "../features/ranking-feature.service";
import type {
  RankedCandidate,
  RankingMode,
  RecommendationCandidate,
} from "../../../types/ranking/ranking.types";

const RESULT_SET_LIMIT = 180;

@Injectable()
export class RecommendationRankingService {
  constructor(
    private readonly rules: RecommendationRuleService,
    private readonly features: RankingFeatureService,
  ) {}

  // Giữ version Phase 2 để client cũ và analytics cũ vẫn đọc được trường ruleVersion.
  getRuleVersion(): string {
    return this.rules.getRuleVersion();
  }

  // Trả version policy đang dùng để cache không phục vụ nhầm kết quả giữa control và hybrid.
  getPolicyVersion(mode: RankingMode): string {
    return mode === "HYBRID"
      ? this.rules.getHybridPolicyVersion()
      : this.rules.getRuleVersion();
  }

  // Expose feature flag qua facade để query service không phụ thuộc trực tiếp vào ConfigService.
  isHybridRankingEnabled(): boolean {
    return this.rules.isHybridRankingEnabled();
  }

  // Chấm điểm theo mode đã được experiment service quyết định; CONTROL dùng công thức cũ, HYBRID dùng feature Phase 4.
  rank(
    candidates: RecommendationCandidate[],
    products: PreferenceValue[],
    categories: PreferenceValue[],
    brands: PreferenceValue[],
    context: SessionContext | null,
    strategy: RecommendationStrategy,
    options: { mode?: RankingMode; surface?: RecommendationSurface } = {},
  ): RankedCandidate[] {
    const mode = options.mode ?? "CONTROL";
    const surface = options.surface ?? "home";
    const ranked = candidates
      .map((candidate) =>
        mode === "HYBRID"
          ? this.scoreHybrid(candidate, products, categories, brands, context)
          : this.scoreControl(candidate, products, categories, brands, context),
      )
      .sort(this.compareCandidates);
    const mixed =
      strategy === "COLD_START" ? this.applyColdStartMix(ranked) : ranked;
    return this.applyDiversity(mixed, surface).slice(0, RESULT_SET_LIMIT);
  }

  // Giữ score Phase 2 làm baseline để A/B test chỉ đo tác động của feature mới.
  private scoreControl(
    candidate: RecommendationCandidate,
    products: PreferenceValue[],
    categories: PreferenceValue[],
    brands: PreferenceValue[],
    context: SessionContext | null,
  ): RankedCandidate {
    const productScore = this.decayedScore(
      products.find(
        (item) => item.dimensionKey === candidate.product.productId,
      ),
    );
    const categoryScore = this.decayedScore(
      categories.find(
        (item) => item.dimensionKey === candidate.product.categoryId,
      ),
    );
    const brandScore = this.decayedScore(
      brands.find((item) => item.dimensionKey === candidate.product.brandId),
    );
    const contextScore =
      (candidate.product.categoryId &&
      context?.recentCategoryIds.includes(candidate.product.categoryId)
        ? 0.7
        : 0) +
      (candidate.product.brandId &&
      context?.recentBrandIds.includes(candidate.product.brandId)
        ? 0.3
        : 0);
    const totalSold = Number.isFinite(candidate.product.totalSold)
      ? Math.max(0, candidate.product.totalSold)
      : 0;
    const popularity = Math.min(1, Math.log1p(totalSold) / 12);
    const ratingValue = Number(candidate.product.ratingAvg ?? 0);
    const rating = Number.isFinite(ratingValue)
      ? Math.max(0, Math.min(1, ratingValue / 5))
      : 0;
    const freshness = Math.max(
      0,
      Math.min(
        1,
        1 -
          (Date.now() - candidate.product.createdAt.getTime()) /
            (1000 * 60 * 60 * 24 * 365),
      ),
    );
    const exploration =
      (candidate.sources.has("NEWEST") || candidate.sources.has("EXPLORE")) &&
      !candidate.sources.has("PRODUCT_AFFINITY")
        ? 1
        : 0;
    const weights = this.rules.getRankingWeights();
    const score =
      weights.profileAffinity * Math.min(1, productScore / 8) +
      weights.sessionContext *
        Math.min(1, (categoryScore + brandScore + contextScore) / 4) +
      weights.popularity * popularity +
      weights.freshness * freshness +
      weights.quality * rating +
      weights.exploration * exploration;
    return { ...candidate, score };
  }

  // Tính feature Phase 4 bằng policy cố định; feature thiếu nhận điểm 0 để các candidate luôn so sánh trên cùng một thang điểm.
  private scoreHybrid(
    candidate: RecommendationCandidate,
    products: PreferenceValue[],
    categories: PreferenceValue[],
    brands: PreferenceValue[],
    context: SessionContext | null,
  ): RankedCandidate {
    const features = this.features.build(
      candidate,
      products,
      categories,
      brands,
      context,
    );
    const weights = this.rules.getHybridRankingWeights();
    const score =
      (Object.keys(weights) as Array<keyof typeof weights>).reduce(
        (sum, key) => sum + weights[key] * features[key],
        0,
      ) - features.negativePenalty;
    return {
      ...candidate,
      score: Math.max(0, Math.min(1, score)),
      features,
    };
  }

  // Decay baseline preference đúng theo policy Phase 2 để control không đổi semantics.
  private decayedScore(value: PreferenceValue | undefined): number {
    if (!value) return 0;
    const ageDays = Math.max(
      0,
      (Date.now() - value.lastSignalAt.getTime()) / 86_400_000,
    );
    const halfLife = this.rules.getProfileHalfLifeDays();
    return Number.isFinite(value.score)
      ? value.score * Math.pow(0.5, ageDays / halfLife)
      : 0;
  }

  // Diversity chạy theo cửa sổ surface cố định để pageSize request khác nhau không làm thay đổi ranking canonical.
  private applyDiversity(
    items: RankedCandidate[],
    surface: RecommendationSurface,
  ): RankedCandidate[] {
    const limits = this.rules.getDiversityLimits(surface);
    const output: RankedCandidate[] = [];
    const remaining = [...items];
    while (remaining.length > 0 && output.length < RESULT_SET_LIMIT) {
      const windowSize = Math.min(limits.windowSize, remaining.length);
      output.push(...this.diversifyWindow(remaining, windowSize, limits));
    }
    return output;
  }

  // Greedy pass quét toàn bộ phần còn lại để kéo item đa dạng ở rank thấp lên trước khi buộc phải relax quota.
  private diversifyWindow(
    remaining: RankedCandidate[],
    windowSize: number,
    limits: {
      category: number;
      brand: number;
      shop: number;
      windowSize: number;
    },
  ): RankedCandidate[] {
    const counts = {
      category: new Map<string, number>(),
      brand: new Map<string, number>(),
      shop: new Map<string, number>(),
    };
    const selected: RankedCandidate[] = [];
    const selectedIds = new Set<string>();
    for (const item of remaining) {
      if (selected.length >= windowSize) break;
      if (this.canAdd(item.product, counts, limits)) {
        this.addCounts(item.product, counts);
        selected.push(item);
        selectedIds.add(item.product.productId);
      }
    }
    for (const item of remaining) {
      if (selected.length >= windowSize) break;
      if (selectedIds.has(item.product.productId)) continue;
      this.addCounts(item.product, counts);
      selected.push({ ...item, diversityRelaxed: true });
      selectedIds.add(item.product.productId);
    }
    for (const item of selected) {
      const index = remaining.findIndex(
        (candidate) => candidate.product.productId === item.product.productId,
      );
      if (index >= 0) remaining.splice(index, 1);
    }
    return selected;
  }

  // Kiểm tra quota category/brand/shop ở strict pass mà không loại bỏ item hợp lệ khỏi result set.
  private canAdd(
    product: RecommendationCatalogProduct,
    counts: {
      category: Map<string, number>;
      brand: Map<string, number>;
      shop: Map<string, number>;
    },
    limits: { category: number; brand: number; shop: number },
  ): boolean {
    const category = product.categoryId ?? "unknown";
    const brand = product.brandId ?? "unknown";
    const shop = product.sellerShopId ?? product.externalShopId ?? "unknown";
    return (
      (counts.category.get(category) ?? 0) < limits.category &&
      (counts.brand.get(brand) ?? 0) < limits.brand &&
      (counts.shop.get(shop) ?? 0) < limits.shop
    );
  }

  // Cập nhật counter sau mỗi lựa chọn để diversity invariant không phụ thuộc vào source candidate.
  private addCounts(
    product: RecommendationCatalogProduct,
    counts: {
      category: Map<string, number>;
      brand: Map<string, number>;
      shop: Map<string, number>;
    },
  ): void {
    const keys = {
      category: product.categoryId ?? "unknown",
      brand: product.brandId ?? "unknown",
      shop: product.sellerShopId ?? product.externalShopId ?? "unknown",
    };
    for (const key of ["category", "brand", "shop"] as const) {
      const map = counts[key];
      const value = keys[key];
      map.set(value, (map.get(value) ?? 0) + 1);
    }
  }

  // Cold-start giữ quota source cũ trước khi diversity pass để guest vẫn có mix trending/newest/explore ổn định.
  private applyColdStartMix(items: RankedCandidate[]): RankedCandidate[] {
    const quotas: Array<[string, number]> = [
      ["TRENDING", 72],
      ["NEWEST", 54],
      ["BEST_SELLING", 36],
      ["EXPLORE", 18],
    ];
    const selected = new Set<string>();
    const output: RankedCandidate[] = [];
    for (const [source, quota] of quotas) {
      let sourceCount = 0;
      for (const item of items) {
        if (
          output.length >= RESULT_SET_LIMIT ||
          sourceCount >= quota ||
          selected.has(item.product.productId) ||
          !item.sources.has(source)
        )
          continue;
        selected.add(item.product.productId);
        output.push(item);
        sourceCount += 1;
      }
    }
    for (const item of items) {
      if (
        output.length >= RESULT_SET_LIMIT ||
        selected.has(item.product.productId)
      )
        continue;
      selected.add(item.product.productId);
      output.push(item);
    }
    return output;
  }

  // Tie-breaker deterministic giúp cache và pagination không thay đổi giữa hai request cùng snapshot.
  private compareCandidates(
    left: RankedCandidate,
    right: RankedCandidate,
  ): number {
    return (
      right.score - left.score ||
      (right.contributions?.length ?? 0) - (left.contributions?.length ?? 0) ||
      left.product.productId.localeCompare(right.product.productId)
    );
  }
}
