// File này chỉ dùng AI model score để xếp candidate; diversity là ràng buộc danh sách sau xếp hạng.
// Không có phép cộng trọng số Standard hay nhánh fallback trong serving path.

import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { RecommendationCatalogProduct } from '@/modules/catalog/application/types/catalog-product.type';
import { RecommendationRuleService } from '@/modules/profiles/application/services/rules/recommendation-rule.service';
import type {
    RecommendationSurface,
} from '@/modules/recommendation/application/types/recommendation.types';
import type {
    RankedCandidate,
    RankingFeatureVector,
    RecommendationCandidate,
} from '@/modules/recommendation/application/types/ranking/ranking.types';

const RESULT_SET_LIMIT = 180;

@Injectable()
export class RecommendationRankingService {
    constructor(private readonly rules: RecommendationRuleService) {}

    // Version đi vào cache key và attribution để phân biệt model/policy đã tạo response.
    getPolicyVersion(): string {
        return this.rules.getRuleVersion();
    }

    // Mỗi candidate phải có một raw score hữu hạn từ model; batch thiếu hoặc sai thì không phát danh sách giả.
    rank(
        candidates: RecommendationCandidate[],
        scores: ReadonlyMap<string, number>,
        features: ReadonlyMap<string, RankingFeatureVector>,
        surface: RecommendationSurface = 'home',
    ): RankedCandidate[] {
        if (candidates.length === 0) return [];
        const ranked = candidates
            .map((candidate) => {
                const productId = candidate.product.productId;
                const score = scores.get(productId);
                // Reject thiếu/NaN score thay vì âm thầm thay bằng một công thức khác.
                if (score === undefined || !Number.isFinite(score)) {
                    throw new ServiceUnavailableException(
                        'RANKING_MODEL_RETURNED_INCOMPLETE_SCORES',
                    );
                }
                return {
                    ...candidate,
                    score,
                    features: features.get(productId),
                };
            })
            .sort(this.compareCandidates);
        return this.applyDiversity(ranked, surface).slice(0, RESULT_SET_LIMIT);
    }

    // Diversity giữ ràng buộc category/brand/shop mà không thay model score của từng sản phẩm.
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

    // Ưu tiên item trong thứ tự model thỏa quota; lượt hai nới quota để không bỏ candidate hợp lệ.
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
                (candidate) =>
                    candidate.product.productId === item.product.productId,
            );
            if (index >= 0) remaining.splice(index, 1);
        }
        return selected;
    }

    // Quota kiểm tra riêng từng chiều; product không bị loại vì lượt hai luôn cho phép relax.
    private canAdd(
        product: RecommendationCatalogProduct,
        counts: {
            category: Map<string, number>;
            brand: Map<string, number>;
            shop: Map<string, number>;
        },
        limits: { category: number; brand: number; shop: number },
    ): boolean {
        const category = product.categoryId ?? 'unknown';
        const brand = product.brandId ?? 'unknown';
        const shop = product.sellerShopId ?? 'unknown';
        return (
            (counts.category.get(category) ?? 0) < limits.category &&
            (counts.brand.get(brand) ?? 0) < limits.brand &&
            (counts.shop.get(shop) ?? 0) < limits.shop
        );
    }

    // Tăng counter sau mỗi lần nhận để quota có hiệu lực xuyên suốt cửa sổ diversity.
    private addCounts(
        product: RecommendationCatalogProduct,
        counts: {
            category: Map<string, number>;
            brand: Map<string, number>;
            shop: Map<string, number>;
        },
    ): void {
        const keys = {
            category: product.categoryId ?? 'unknown',
            brand: product.brandId ?? 'unknown',
            shop: product.sellerShopId ?? 'unknown',
        };
        for (const key of ['category', 'brand', 'shop'] as const) {
            const map = counts[key];
            const value = keys[key];
            map.set(value, (map.get(value) ?? 0) + 1);
        }
    }

    // Tie-breaker ổn định giúp cache và pagination giữ thứ tự khi model trả score bằng nhau.
    private compareCandidates(
        left: RankedCandidate,
        right: RankedCandidate,
    ): number {
        return (
            right.score - left.score ||
            (right.contributions?.length ?? 0) -
                (left.contributions?.length ?? 0) ||
            left.product.productId.localeCompare(right.product.productId)
        );
    }
}
