// File này hợp nhất candidate từ nhiều source theo request; không sở hữu catalog persistence hoặc ranking policy.

import { Injectable } from '@nestjs/common';
import type {
    CatalogProductExclusionOptions,
    RecommendationCatalogProduct,
} from '@/modules/catalog/application/types/catalog-product.type';
import type { CandidateContributionInput } from '@/modules/recommendation/application/types/candidates/candidate-source.types';
import type { RecommendationCandidate } from '@/modules/recommendation/application/types/ranking/ranking.types';

type CandidateContribution = CandidateContributionInput & { source: string };

// Collector request-scoped cho candidate union; deduplicate product nhưng bảo toàn attribution của mọi source.
export class CandidateUnion {
    private readonly candidates = new Map<string, RecommendationCandidate>();

    constructor(
        private readonly excludedProductIds: ReadonlySet<string>,
        private readonly maxSize: number,
        private readonly shopExclusions: CatalogProductExclusionOptions = {},
    ) {}

    // Merge toàn bộ candidate của source; giới hạn pool được áp dụng sau khi biết đủ source để không làm semantic/co-behavior bị bỏ qua.
    add(
        products: RecommendationCatalogProduct[],
        source: string,
        contributionByProductId?: Map<
            string,
            | Omit<CandidateContribution, 'source'>
            | Omit<CandidateContribution, 'source'>[]
        >,
    ): void {
        for (const product of products) {
            if (this.excludedProductIds.has(product.productId)) continue;
            if (this.isExcludedByShop(product)) continue;
            const detail = contributionByProductId?.get(product.productId);
            const contributions: CandidateContribution[] = detail
                ? (Array.isArray(detail) ? detail : [detail]).map((item) => ({
                      source,
                      ...item,
                  }))
                : [];
            const current = this.candidates.get(product.productId);
            if (current) {
                current.sources.add(source);
                if (contributions.length)
                    current.contributions = [
                        ...(current.contributions ?? []),
                        ...contributions,
                    ];
                continue;
            }
            this.candidates.set(product.productId, {
                product,
                sources: new Set([source]),
                contributions: contributions.length ? contributions : undefined,
            });
        }
    }

    // Lớp bảo vệ cuối cùng giữ invariant product detail không trả sản phẩm cùng shop dù source adapter có lỗi hoặc dữ liệu cũ.
    private isExcludedByShop(product: RecommendationCatalogProduct): boolean {
        return Boolean(
            (this.shopExclusions.excludeSellerShopId &&
                product.originType === 'INTERNAL' &&
                product.sellerShopId ===
                    this.shopExclusions.excludeSellerShopId) ||
            (this.shopExclusions.excludeExternalShopId &&
                product.originType === 'EXTERNAL' &&
                product.externalShopId ===
                    this.shopExclusions.excludeExternalShopId),
        );
    }

    // Cắt pool theo round-robin giữa các source, sau đó ưu tiên item có nhiều attribution hơn.
    values(): RecommendationCandidate[] {
        const all = [...this.candidates.values()];
        if (all.length <= this.maxSize) return this.sortByCoverage(all);

        const bySource = new Map<string, RecommendationCandidate[]>();
        for (const candidate of all) {
            for (const source of candidate.sources) {
                const sourceCandidates = bySource.get(source) ?? [];
                sourceCandidates.push(candidate);
                bySource.set(source, sourceCandidates);
            }
        }
        for (const [source, candidates] of bySource)
            candidates.sort((left, right) =>
                this.compareSourceCandidates(left, right, source),
            );

        const selected = new Set<string>();
        const cursors = new Map<string, number>();
        const sources = [...bySource.keys()];
        while (selected.size < this.maxSize) {
            let added = false;
            for (const source of sources) {
                const candidates = bySource.get(source) ?? [];
                let cursor = cursors.get(source) ?? 0;
                while (
                    candidates[cursor] &&
                    selected.has(candidates[cursor]!.product.productId)
                )
                    cursor += 1;
                cursors.set(source, cursor);
                const next = candidates[cursor];
                if (!next) continue;
                selected.add(next.product.productId);
                cursors.set(source, (cursors.get(source) ?? 0) + 1);
                added = true;
                if (selected.size >= this.maxSize) break;
            }
            if (!added) break;
        }

        return this.sortByCoverage(
            all.filter((candidate) =>
                selected.has(candidate.product.productId),
            ),
        );
    }

    private sortByCoverage(
        candidates: RecommendationCandidate[],
    ): RecommendationCandidate[] {
        return [...candidates].sort(this.compareCandidates);
    }

    private compareCandidates(
        left: RecommendationCandidate,
        right: RecommendationCandidate,
    ): number {
        return (
            right.sources.size - left.sources.size ||
            left.product.productId.localeCompare(right.product.productId)
        );
    }

    // Khi pool vượt giới hạn, ưu tiên candidate có raw score cao trong chính source trước khi xét coverage.
    private compareSourceCandidates(
        left: RecommendationCandidate,
        right: RecommendationCandidate,
        source: string,
    ): number {
        return (
            this.sourceScore(right, source) - this.sourceScore(left, source) ||
            this.compareCandidates(left, right)
        );
    }

    // Catalog source có raw score cố định 1; semantic/relation giữ score thực để không bị cắt sai khi union.
    private sourceScore(
        candidate: RecommendationCandidate,
        source: string,
    ): number {
        const scores = (candidate.contributions ?? [])
            .filter((item) => item.source === source)
            .map((item) =>
                Number.isFinite(item.rawScore) ? item.rawScore : 0,
            );
        return scores.length ? Math.max(...scores, 0) : 0;
    }
}

// Factory stateless để mỗi request có collector riêng, tránh state leak giữa user/session.
@Injectable()
export class CandidateUnionService {
    create(
        excludedProductIds: string[],
        maxSize = 300,
        shopExclusions: CatalogProductExclusionOptions = {},
    ): CandidateUnion {
        const safeMaxSize = Number.isFinite(maxSize)
            ? Math.trunc(maxSize)
            : 300;
        return new CandidateUnion(
            new Set(excludedProductIds),
            Math.min(Math.max(safeMaxSize, 1), 300),
            shopExclusions,
        );
    }
}
