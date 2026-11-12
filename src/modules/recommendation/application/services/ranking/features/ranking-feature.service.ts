// File này chuyển profile, session và candidate attribution thành feature vector; không xếp hạng và không truy cập database.
// Feature đầu vào được giới hạn [0, 1]; điểm đầu ra của AI ranking là raw relevance score.

import { Injectable } from '@nestjs/common';
import type {
    PreferenceValue,
    SessionContext,
} from '@/modules/profiles/application/types/profile.types';
import { RecommendationRuleService } from '@/modules/profiles/application/services/rules/recommendation-rule.service';
import type {
    RankingFeatureVector,
    RecommendationCandidate,
} from '@/modules/recommendation/application/types/ranking/ranking.types';

export type RankingPreferenceLookup = {
    product: ReadonlyMap<string, PreferenceValue>;
    category: ReadonlyMap<string, PreferenceValue>;
    brand: ReadonlyMap<string, PreferenceValue>;
};

@Injectable()
export class RankingFeatureService {
    constructor(private readonly rules: RecommendationRuleService) {}

    // Tính từng feature độc lập để model nhận cùng schema, còn evaluator có thể kiểm thử từng tiêu chí.
    build(
        candidate: RecommendationCandidate,
        products: PreferenceValue[],
        categories: PreferenceValue[],
        brands: PreferenceValue[],
        context: SessionContext | null,
        lookup?: RankingPreferenceLookup,
        referenceTime: Date = new Date(),
    ): RankingFeatureVector {
        const preferenceLookup =
            lookup ?? this.createPreferenceLookup(products, categories, brands);
        const productPreference = preferenceLookup.product.get(
            candidate.product.productId,
        );
        const categoryPreference = candidate.product.categoryId
            ? preferenceLookup.category.get(candidate.product.categoryId)
            : undefined;
        const brandPreference = candidate.product.brandId
            ? preferenceLookup.brand.get(candidate.product.brandId)
            : undefined;
        const contributions = candidate.contributions ?? [];
        const semantic = contributions
            .filter((item) => item.source === 'SEMANTIC_SIMILARITY')
            .map((item) => this.normalizeSemantic(item.rawScore))
            .reduce((max, value) => Math.max(max, value), 0);
        const coBehavior = contributions
            .filter((item) => item.source === 'CO_BEHAVIOR')
            .map((item) =>
                this.normalizeRelation(item.rawScore, item.relationType),
            )
            .reduce((max, value) => Math.max(max, value), 0);
        const affinityConfig = this.rules.getProfileAffinityConfig();
        const profileProduct = this.positivePreferenceScore(
            productPreference,
            referenceTime,
            affinityConfig.product.scale,
        );
        const profileCategory = this.positivePreferenceScore(
            categoryPreference,
            referenceTime,
            affinityConfig.category.scale,
        );
        const profileBrand = this.positivePreferenceScore(
            brandPreference,
            referenceTime,
            affinityConfig.brand.scale,
        );
        // Config chuẩn hóa tổng ba trọng số về 1 nên tổ hợp lồi luôn bounded trong [0, 1].
        const profileAffinity =
            profileProduct * affinityConfig.product.weight +
            profileCategory * affinityConfig.category.weight +
            profileBrand * affinityConfig.brand.weight;
        const sessionContext = this.sessionScore(candidate, context);
        // Dữ liệu sales lỗi chỉ làm mất riêng tín hiệu sales; không được xóa hạng nguồn hợp lệ.
        const totalSold = Number.isFinite(candidate.product.totalSold)
            ? Math.max(0, candidate.product.totalSold)
            : 0;
        const popularity = this.clamp(
            Math.max(
                Math.log1p(totalSold) / 12,
                this.sourceRankScore(contributions, [
                    'TRENDING',
                    'BEST_SELLING',
                ]),
            ),
        );
        const freshness = this.freshnessScore(
            candidate.product.createdAt,
            referenceTime,
        );
        const quality = this.qualityScore(candidate);
        const exploration = this.explorationScore(candidate, profileAffinity);
        const negativePenalty = this.negativePenalty(
            [
                [productPreference, affinityConfig.product.scale],
                [categoryPreference, affinityConfig.category.scale],
                [brandPreference, affinityConfig.brand.scale],
            ],
            referenceTime,
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

    // Tổng dương đã decay tại lastSignalAt tiếp tục giảm đến thời điểm ranking.
    // Ngưỡng M theo dimension giữ điểm trong [0, 1] mà không dùng mẫu số cố định cũ.
    private positivePreferenceScore(
        value: PreferenceValue | undefined,
        referenceTime: Date,
        scale: number,
    ): number {
        if (!value) return 0;
        return Math.min(
            1,
            this.decayedComponentScore(
                value.positiveScore,
                value.lastSignalAt,
                referenceTime,
            ) / scale,
        );
    }

    // Tổng âm đã được lưu riêng nên không triệt tiêu sở thích dương của cùng một mục.
    private negativePenalty(
        values: Array<[PreferenceValue | undefined, number]>,
        referenceTime: Date,
    ): number {
        const negative = values.reduce((sum, [value, scale]) => {
            if (!value) return sum;
            return (
                sum +
                this.decayedComponentScore(
                    value.negativeScore,
                    value.lastSignalAt,
                    referenceTime,
                ) /
                    scale
            );
        }, 0);
        return Math.min(0.15, this.clamp(negative) * 0.15);
    }

    // Mỗi tổng tại mốc lastSignalAt là tổng các event đã decay riêng khi projection.
    // Chỉ giảm thêm từ mốc đó đến referenceTime; sự kiện tương lai có tuổi 0.
    private decayedComponentScore(
        score: number,
        lastSignalAt: Date,
        referenceTime: Date,
    ): number {
        const ageDays = Math.max(
            0,
            (referenceTime.getTime() - lastSignalAt.getTime()) / 86_400_000,
        );
        return (
            Math.max(0, score) *
            Math.pow(0.5, ageDays / this.rules.getProfileHalfLifeDays())
        );
    }

    // Hai chuỗi category/brand là các khóa duy nhất, mới nhất đứng đầu; chỉ hành động chủ động mới cập nhật chúng.
    // Chiết khấu tuyến tính theo vị trí trong từng chuỗi, rồi lấy trung bình hai chiều để score nằm trong [0, 1].
    // Anchor thuộc provenance của candidate nên không được cộng lần nữa vào bằng chứng sở thích của phiên.
    private sessionScore(
        candidate: RecommendationCandidate,
        context: SessionContext | null,
    ): number {
        if (!context) return 0;
        const category = this.sessionPositionWeight(
            candidate.product.categoryId,
            context.recentCategoryIds,
        );
        const brand = this.sessionPositionWeight(
            candidate.product.brandId,
            context.recentBrandIds,
        );
        return (category + brand) / 2;
    }

    // Dùng cùng ý tưởng trọng số vị trí tuyến tính như v-SKNN, nhưng chỉ chấm thuộc tính category/brand.
    // Đây không phải toàn bộ v-SKNN vì feature này không tìm phiên láng giềng hay tính cosine.
    // Không có khóa hoặc không khớp thì 0; vị trí đầu là 1, cuối là 1/L với L là độ dài danh sách.
    private sessionPositionWeight(
        key: string | null | undefined,
        recentKeys: string[],
    ): number {
        if (!key || recentKeys.length === 0) return 0;
        const position = recentKeys.indexOf(key);
        if (position < 0) return 0;
        return (recentKeys.length - position) / recentKeys.length;
    }

    // Semantic score của Qdrant đã là similarity; clamp để provider thay đổi không làm điểm vượt policy.
    private normalizeSemantic(rawScore: number): number {
        return this.clamp(Number.isFinite(rawScore) ? rawScore : 0);
    }

    // Relation score dùng scale theo loại quan hệ để purchase mạnh hơn view mà vẫn không vượt [0, 1].
    private normalizeRelation(
        rawScore: number,
        relationType?: 'CO_VIEW' | 'CO_CART' | 'CO_PURCHASE',
    ): number {
        const scale = this.rules.getRelationScoreScale(relationType);
        if (!Number.isFinite(scale) || scale <= 0) return 0;
        const positive = Math.max(0, Number.isFinite(rawScore) ? rawScore : 0);
        // Chia tỷ số nhỏ hơn cho tổng để phép cộng hai số hữu hạn lớn không tràn Infinity.
        if (positive >= scale) {
            const inverseRatio = scale / positive;
            return 1 / (1 + inverseRatio);
        }
        const ratio = positive / scale;
        return ratio / (1 + ratio);
    }

    // Source rank bổ sung tín hiệu cho các source catalog vốn chỉ có danh sách đã sắp xếp.
    private sourceRankScore(
        contributions: NonNullable<RecommendationCandidate['contributions']>,
        sources: string[],
    ): number {
        return contributions
            .filter((item) => sources.includes(item.source))
            .map((item) => {
                const rank = item.sourceRank;
                const size = item.sourceSize;
                // Thiếu rank/size thì không suy đoán candidate đang đứng đầu source.
                if (
                    !Number.isFinite(rank) ||
                    !Number.isFinite(size) ||
                    rank === undefined ||
                    size === undefined ||
                    rank < 1 ||
                    size < 1 ||
                    rank > size
                ) {
                    return 0;
                }
                // Hạng 1 có điểm 1, hạng cuối 0; source chỉ có một item nhận điểm 1.
                return size === 1 ? 1 : this.clamp(1 - (rank - 1) / (size - 1));
            })
            .reduce((max, value) => Math.max(max, value), 0);
    }

    // Freshness dùng bucket thời gian cố định để score ổn định và không bị sản phẩm mới áp đảo lâu dài.
    private freshnessScore(createdAt: Date, referenceTime: Date): number {
        const ageDays = Math.max(
            0,
            (referenceTime.getTime() - createdAt.getTime()) / 86_400_000,
        );
        if (ageDays <= 1) return 1;
        if (ageDays <= 7) return 0.8;
        if (ageDays <= 30) return 0.55;
        if (ageDays <= 90) return 0.3;
        return 0.1;
    }

    // Quality kết hợp rating, lượng review log-scale và stock; eligibility vẫn do catalog filter quyết định.
    private qualityScore(candidate: RecommendationCandidate): number {
        const rating = this.clamp(Number(candidate.product.ratingAvg ?? 0) / 5);
        // Count lỗi chỉ bỏ tín hiệu review; không để NaN/Infinity xóa rating và eligibility hợp lệ.
        const reviewCount = Number.isFinite(candidate.product.reviewCount)
            ? Math.max(0, candidate.product.reviewCount)
            : 0;
        const reviews = this.clamp(Math.log1p(reviewCount) / Math.log1p(100));
        return this.clamp(
            rating * 0.55 +
                reviews * 0.25 +
                (candidate.product.isInStock ? 0.2 : 0),
        );
    }

    // Exploration dành điểm cho item mới hoặc source explore khi candidate chưa có affinity mạnh.
    private explorationScore(
        candidate: RecommendationCandidate,
        profileAffinity: number,
    ): number {
        if (profileAffinity > 0.4) return 0;
        return candidate.sources.has('EXPLORE') ||
            candidate.sources.has('NEWEST')
            ? 1
            : 0;
    }

    // Tìm preference theo dimension key mà không expose entity persistence ra ranker.
    // Tạo lookup dùng chung cho cả deterministic ranker và ML adapter để batch lớn không quét lại preference arrays.
    createPreferenceLookup(
        products: PreferenceValue[],
        categories: PreferenceValue[],
        brands: PreferenceValue[],
    ): RankingPreferenceLookup {
        return {
            product: new Map(products.map((item) => [item.dimensionKey, item])),
            category: new Map(
                categories.map((item) => [item.dimensionKey, item]),
            ),
            brand: new Map(brands.map((item) => [item.dimensionKey, item])),
        };
    }

    // Clamp tập trung giữ feature trong schema [0, 1] trước khi gửi đến model.
    private clamp(value: number): number {
        return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
    }
}
