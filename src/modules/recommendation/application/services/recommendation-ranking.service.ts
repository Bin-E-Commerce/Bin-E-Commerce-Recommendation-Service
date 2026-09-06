// Service này owns score, cold-start mix và diversity; query service chỉ điều phối dữ liệu và phân trang response.

import { Injectable } from "@nestjs/common";
import type { RecommendationCatalogProduct } from "../../../catalog/application/types/catalog-product.type";
import { RecommendationRuleService } from "../../../profiles/application/services/rules/recommendation-rule.service";
import type { PreferenceValue, SessionContext } from "../../../profiles/application/types/profile.types";
import type { RecommendationStrategy } from "../types/recommendation.types";

export type RecommendationCandidate = {
  product: RecommendationCatalogProduct;
  sources: Set<string>;
};

type RankedCandidate = RecommendationCandidate & { score: number };

const RESULT_SET_LIMIT = 180;

@Injectable()
export class RecommendationRankingService {
  constructor(private readonly rules: RecommendationRuleService) {}

  // Expose rule version cho response để client/debug có thể đối chiếu kết quả với policy đang chạy.
  getRuleVersion(): string {
    return this.rules.getRuleVersion();
  }

  // Chấm điểm, áp dụng cold-start/diversity và trả result set ổn định trước khi controller phân trang.
  rank(
    candidates: RecommendationCandidate[],
    products: PreferenceValue[],
    categories: PreferenceValue[],
    brands: PreferenceValue[],
    context: SessionContext | null,
    strategy: RecommendationStrategy,
  ): RankedCandidate[] {
    const ranked = candidates
      .map((candidate) => this.scoreCandidate(candidate, products, categories, brands, context))
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.product.productId.localeCompare(right.product.productId),
      );
    const strategyRanked = strategy === "COLD_START" ? this.applyColdStartMix(ranked) : ranked;
    return this.applyDiversity(strategyRanked).slice(0, RESULT_SET_LIMIT);
  }

  // Tính score đã normalize theo profile affinity, session context, popularity, freshness, quality và exploration.
  private scoreCandidate(
    candidate: RecommendationCandidate,
    products: PreferenceValue[],
    categories: PreferenceValue[],
    brands: PreferenceValue[],
    context: SessionContext | null,
  ): RankedCandidate {
    const productScore = this.decayedScore(
      products.find((item) => item.dimensionKey === candidate.product.productId),
    );
    const categoryScore = this.decayedScore(
      categories.find((item) => item.dimensionKey === candidate.product.categoryId),
    );
    const brandScore = this.decayedScore(
      brands.find((item) => item.dimensionKey === candidate.product.brandId),
    );
    const contextScore =
      (candidate.product.categoryId && context?.recentCategoryIds.includes(candidate.product.categoryId)
        ? 0.7
        : 0) +
      (candidate.product.brandId && context?.recentBrandIds.includes(candidate.product.brandId) ? 0.3 : 0);
    const popularity = Math.min(1, Math.log1p(candidate.product.totalSold) / 12);
    const rating = Math.min(1, Number(candidate.product.ratingAvg ?? 0) / 5);
    const freshness = Math.max(
      0,
      1 - (Date.now() - candidate.product.createdAt.getTime()) / (1000 * 60 * 60 * 24 * 365),
    );
    const exploration =
      (candidate.sources.has("NEWEST") || candidate.sources.has("EXPLORE")) &&
      !candidate.sources.has("PRODUCT_AFFINITY")
        ? 1
        : 0;
    const score =
      0.35 * Math.min(1, productScore / 8) +
      0.2 * Math.min(1, (categoryScore + brandScore + contextScore) / 4) +
      0.15 * popularity +
      0.1 * freshness +
      0.1 * rating +
      0.1 * exploration;
    return { ...candidate, score };
  }

  // Giảm điểm theo tuổi tín hiệu; half-life được quản lý tập trung trong rule service.
  private decayedScore(value: PreferenceValue | undefined): number {
    if (!value) return 0;
    const ageDays = Math.max(
      0,
      (Date.now() - value.lastSignalAt.getTime()) / (1000 * 60 * 60 * 24),
    );
    return value.score * Math.pow(0.5, ageDays / this.rules.getProfileHalfLifeDays());
  }

  // Giới hạn category/brand/shop để danh sách đa dạng nhưng vẫn fill đủ khi catalog nhỏ.
  private applyDiversity(items: RankedCandidate[]): RankedCandidate[] {
    const categories = new Map<string, number>();
    const brands = new Map<string, number>();
    const shops = new Map<string, number>();
    const output: RankedCandidate[] = [];
    const skipped: RankedCandidate[] = [];

    for (const item of items) {
      const category = item.product.categoryId ?? "unknown";
      const brand = item.product.brandId ?? "unknown";
      const shop = item.product.sellerShopId ?? item.product.externalShopId ?? "unknown";
      if (
        (categories.get(category) ?? 0) >= 4 ||
        (brands.get(brand) ?? 0) >= 3 ||
        (shops.get(shop) ?? 0) >= 5
      ) {
        skipped.push(item);
        continue;
      }
      categories.set(category, (categories.get(category) ?? 0) + 1);
      brands.set(brand, (brands.get(brand) ?? 0) + 1);
      shops.set(shop, (shops.get(shop) ?? 0) + 1);
      output.push(item);
    }

    return output.length >= Math.min(RESULT_SET_LIMIT, items.length)
      ? output
      : [...output, ...skipped];
  }

  // Cold-start phân bổ quota giữa trending/newest/best-selling/explore để một source không chiếm toàn bộ page.
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
        ) {
          continue;
        }
        selected.add(item.product.productId);
        output.push(item);
        sourceCount += 1;
      }
    }
    for (const item of items) {
      if (output.length >= RESULT_SET_LIMIT || selected.has(item.product.productId)) continue;
      selected.add(item.product.productId);
      output.push(item);
    }
    return output;
  }
}
