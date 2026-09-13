// File này là facade ranking cho Recommendation Service; Standard dùng Hybrid deterministic, AI chỉ là lớp blend tùy chọn.
// Candidate generation không nằm trong file này; service chỉ chấm điểm, diversity và trả kết quả deterministic.

import { Injectable } from "@nestjs/common";
import type { RecommendationCatalogProduct } from "../../../../../catalog/application/types/catalog-product.type";
import {
  RecommendationRuleService,
  type HybridRankingWeights,
} from "../../../../../profiles/application/services/rules/recommendation-rule.service";
import type {
  PreferenceValue,
  SessionContext,
} from "../../../../../profiles/application/types/profile.types";
import type {
  RecommendationStrategy,
  RecommendationSurface,
} from "../../../types/recommendation.types";
import { RankingFeatureService } from "../features/ranking-feature.service";
import type { RankingPreferenceLookup } from "../features/ranking-feature.service";
import type {
  RankedCandidate,
  RankingMode,
  RankingFeatureVector,
  RecommendationCandidate,
} from "../../../types/ranking/ranking.types";

const RESULT_SET_LIMIT = 180;

@Injectable()
export class RecommendationRankingService {
  constructor(
    private readonly rules: RecommendationRuleService,
    private readonly features: RankingFeatureService,
  ) {}

  // Giữ trường ruleVersion trong response để tương thích API, nhưng version mới phản ánh Standard Ranking.
  getRuleVersion(): string {
    return this.rules.getRuleVersion();
  }

  // Tách cache theo Standard và AI-Enhanced để không dùng lẫn kết quả từ hai mode.
  getPolicyVersion(mode: RankingMode): string {
    if (mode === "ML_HYBRID") return this.rules.getMlRankingPolicyVersion();
    return this.rules.getHybridPolicyVersion();
  }

  // Expose ML flag qua ranking facade để query orchestration không phụ thuộc ConfigService.
  isMlRankingEnabled(): boolean {
    return this.rules.isMlRankingEnabled();
  }

  // Trả snapshot policy để query trace không cần đọc ConfigService trực tiếp.
  getPolicySnapshot(): ReturnType<
    RecommendationRuleService["getPolicySnapshot"]
  > {
    return this.rules.getPolicySnapshot();
  }

  // Standard luôn dùng feature Hybrid deterministic; AI-Enhanced chỉ blend thêm prediction hợp lệ.
  rank(
    candidates: RecommendationCandidate[],
    products: PreferenceValue[],
    categories: PreferenceValue[],
    brands: PreferenceValue[],
    context: SessionContext | null,
    strategy: RecommendationStrategy,
    options: {
      mode?: RankingMode;
      surface?: RecommendationSurface;
      mlScores?: ReadonlyMap<string, number>;
      mlFeatures?: ReadonlyMap<string, RankingFeatureVector>;
    } = {},
  ): RankedCandidate[] {
    const mode = options.mode ?? "HYBRID";
    const surface = options.surface ?? "home";
    // Tạo lookup một lần cho cả batch; ranker không cần quét lại ba mảng preference cho từng product.
    const preferences = this.createPreferenceLookup(
      products,
      categories,
      brands,
    );
    const hybridWeights = this.rules.getHybridRankingWeights();
    const ranked = candidates
      .map((candidate) =>
        mode === "ML_HYBRID"
          ? this.scoreMlHybrid(
              candidate,
              products,
              categories,
              brands,
              context,
              preferences,
              options.mlScores,
              options.mlFeatures?.get(candidate.product.productId),
              hybridWeights,
            )
          : this.scoreHybrid(
              candidate,
              products,
              categories,
              brands,
              context,
              preferences,
              undefined,
              hybridWeights,
            ),
      )
      .sort(this.compareCandidates);
    const mixed =
      strategy === "COLD_START" ? this.applyColdStartMix(ranked) : ranked;
    return this.applyDiversity(mixed, surface).slice(0, RESULT_SET_LIMIT);
  }

  // Tính điểm Standard từ feature đã chuẩn hóa; feature thiếu nhận 0 để candidate cùng thang điểm.
  private scoreHybrid(
    candidate: RecommendationCandidate,
    products: PreferenceValue[],
    categories: PreferenceValue[],
    brands: PreferenceValue[],
    context: SessionContext | null,
    preferences: RankingPreferenceLookup,
    precomputedFeatures?: RankingFeatureVector,
    weights: HybridRankingWeights = this.rules.getHybridRankingWeights(),
  ): RankedCandidate {
    const features =
      precomputedFeatures ??
      this.features.build(
        candidate,
        products,
        categories,
        brands,
        context,
        preferences,
      );
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

  // Blend ML score tối đa theo policy với Hybrid deterministic; thiếu prediction thì giữ nguyên Hybrid score.
  private scoreMlHybrid(
    candidate: RecommendationCandidate,
    products: PreferenceValue[],
    categories: PreferenceValue[],
    brands: PreferenceValue[],
    context: SessionContext | null,
    preferences: RankingPreferenceLookup,
    mlScores?: ReadonlyMap<string, number>,
    mlFeatures?: RankingFeatureVector,
    weights?: HybridRankingWeights,
  ): RankedCandidate {
    const baseline = this.scoreHybrid(
      candidate,
      products,
      categories,
      brands,
      context,
      preferences,
      mlFeatures,
      weights,
    );
    const mlScore = mlScores?.get(candidate.product.productId);
    if (mlScore === undefined || !Number.isFinite(mlScore)) return baseline;
    const blend = this.rules.getMlRankingBlend();
    return {
      ...baseline,
      score: Math.min(
        1,
        Math.max(0, baseline.score * (1 - blend) + mlScore * blend),
      ),
    };
  }

  // Chuyển preference arrays thành map một lần để ranking có độ phức tạp gần O(candidate count).
  private createPreferenceLookup(
    products: PreferenceValue[],
    categories: PreferenceValue[],
    brands: PreferenceValue[],
  ): RankingPreferenceLookup {
    return {
      product: new Map(products.map((item) => [item.dimensionKey, item])),
      category: new Map(categories.map((item) => [item.dimensionKey, item])),
      brand: new Map(brands.map((item) => [item.dimensionKey, item])),
    };
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
