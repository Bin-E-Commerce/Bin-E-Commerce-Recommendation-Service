// Service này tập trung weight/decay/rule version để ranking và profile projection dùng cùng một policy có thể cấu hình.

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const DEFAULT_WEIGHTS: Record<string, number> = {
    PRODUCT_IMPRESSED: 0.05,
    PRODUCT_VIEWED: 1,
    PRODUCT_CLICKED: 2,
    SEARCH_PERFORMED: 1.5,
    PRODUCT_ADDED_TO_CART: 4,
    PRODUCT_REMOVED_FROM_CART: -2,
};

const DEFAULT_PURCHASE_WEIGHTS = {
    completed: 8,
    returned: -8,
} as const;

const RELATION_WEIGHT_CONFIG_KEYS = {
    PRODUCT_VIEWED: 'RECOMMENDATION_RELATION_CO_VIEW_WEIGHT',
    PRODUCT_CLICKED: 'RECOMMENDATION_RELATION_CO_CLICK_WEIGHT',
    PRODUCT_IMPRESSED: 'RECOMMENDATION_RELATION_CO_IMPRESSION_WEIGHT',
    PRODUCT_ADDED_TO_CART: 'RECOMMENDATION_RELATION_CO_CART_WEIGHT',
} as const;

const LEGACY_RELATION_WEIGHT_CONFIG_KEYS = {
    PRODUCT_VIEWED: 'RELATION_CO_VIEW_WEIGHT',
    PRODUCT_CLICKED: 'RELATION_CO_CLICK_WEIGHT',
    PRODUCT_IMPRESSED: 'RELATION_CO_IMPRESSION_WEIGHT',
    PRODUCT_ADDED_TO_CART: 'RELATION_CO_CART_WEIGHT',
} as const;

const DEFAULT_RELATION_WEIGHTS = {
    PRODUCT_VIEWED: 1,
    PRODUCT_CLICKED: 2,
    PRODUCT_IMPRESSED: 0.05,
    PRODUCT_ADDED_TO_CART: 3,
} as const;

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

export interface RuntimeRecommendationPolicy {
    version: string;
    hybridWeights?: Partial<HybridRankingWeights>;
    mlEnabled?: boolean;
    mlBlend?: number;
}

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
    private runtimePolicy: RuntimeRecommendationPolicy | null = null;

    constructor(private readonly config: ConfigService) {}

    // Cập nhật policy đã được admin validate; runtime override giúp thay đổi ranking mà không cần restart service.
    setRuntimePolicy(policy: RuntimeRecommendationPolicy | null): void {
        this.runtimePolicy = policy;
    }

    // Trả weight ổn định cho projection; config sai hoặc thiếu sẽ dùng default an toàn.
    getInteractionWeight(interactionType: string): number {
        return this.readSignalWeight(
            `RECOMMENDATION_WEIGHT_${interactionType}`,
            DEFAULT_WEIGHTS[interactionType] ?? 0,
        );
    }

    // Purchase/return có policy riêng vì đây là order event, không phải interaction type từ browser.
    getPurchaseWeight(
        eventName: 'order.purchase.completed' | 'order.purchase.returned',
    ): number {
        return this.readSignalWeight(
            eventName === 'order.purchase.completed'
                ? 'RECOMMENDATION_WEIGHT_PURCHASE_COMPLETED'
                : 'RECOMMENDATION_WEIGHT_PURCHASE_RETURNED',
            eventName === 'order.purchase.completed'
                ? DEFAULT_PURCHASE_WEIGHTS.completed
                : DEFAULT_PURCHASE_WEIGHTS.returned,
        );
    }

    // Relation score dùng cùng policy weight nhưng có namespace riêng để thay đổi co-behavior không ảnh hưởng profile.
    getRelationWeight(
        interactionType:
            | 'PRODUCT_VIEWED'
            | 'PRODUCT_CLICKED'
            | 'PRODUCT_IMPRESSED'
            | 'PRODUCT_ADDED_TO_CART',
    ): number {
        return this.readSignalWeight(
            RELATION_WEIGHT_CONFIG_KEYS[interactionType],
            DEFAULT_RELATION_WEIGHTS[interactionType],
            LEGACY_RELATION_WEIGHT_CONFIG_KEYS[interactionType],
        );
    }

    // Purchase relation là positive khi completed và negative correction khi return/refund.
    getPurchaseRelationWeight(returned: boolean): number {
        const weight = this.readSignalWeight(
            'RECOMMENDATION_RELATION_CO_PURCHASE_WEIGHT',
            6,
            'RELATION_CO_PURCHASE_WEIGHT',
        );
        return returned ? -weight : weight;
    }

    // Half-life dài hạn của profile được giới hạn dương để tránh decay sai hoặc score vô hạn.
    getProfileHalfLifeDays(): number {
        const value = Number(
            this.config.get<string>(
                'RECOMMENDATION_PROFILE_HALF_LIFE_DAYS',
                '7',
            ),
        );
        return Number.isFinite(value) && value > 0 ? value : 7;
    }

    // Rule version đi cùng response/cache giúp phân biệt kết quả sinh bởi policy nào khi deploy thay đổi trọng số.
    getRuleVersion(): string {
        if (this.runtimePolicy?.version) return this.runtimePolicy.version;
        return this.config.get<string>(
            'RECOMMENDATION_RULE_VERSION',
            'standard-ranking-v1',
        );
    }

    // Đọc trọng số Standard Ranking và normalize tổng về 1 để policy đổi mà không sửa business logic.
    getHybridRankingWeights(): HybridRankingWeights {
        const configuredWeights = this.runtimePolicy?.hybridWeights;
        const values = Object.fromEntries(
            Object.entries(DEFAULT_HYBRID_RANKING_WEIGHTS).map(
                ([name, defaultValue]) => {
                    const configName = name
                        .replace(/[A-Z]/g, (letter) => `_${letter}`)
                        .toUpperCase();
                    const configured = Number(
                        configuredWeights?.[
                            name as keyof HybridRankingWeights
                        ] ??
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
        const total = Object.values(values).reduce(
            (sum, value) => sum + value,
            0,
        );
        if (total <= 0) return DEFAULT_HYBRID_RANKING_WEIGHTS;
        return Object.fromEntries(
            Object.entries(values).map(([name, value]) => [
                name,
                Number((value / total).toFixed(8)),
            ]),
        ) as unknown as HybridRankingWeights;
    }

    // Trả version policy Standard để cache tách biệt với kết quả có AI blend.
    getHybridPolicyVersion(): string {
        if (this.runtimePolicy?.version) return this.runtimePolicy.version;
        return this.config.get<string>(
            'RECOMMENDATION_RANKING_POLICY_VERSION',
            'standard-ranking-v1',
        );
    }

    // AI là lớp blend tùy chọn; Standard vẫn chạy độc lập khi AI tắt hoặc provider lỗi.
    isMlRankingEnabled(): boolean {
        if (this.runtimePolicy?.mlEnabled !== undefined) {
            return this.runtimePolicy.mlEnabled;
        }
        return this.config.get<string>('ML_RANKING_ENABLED', 'true') === 'true';
    }

    // Giới hạn ML blend tối đa 50% để model mới không thể đột ngột thay toàn bộ behavior đã kiểm chứng.
    getMlRankingBlend(): number {
        const value = Number(
            this.runtimePolicy?.mlBlend ??
                this.config.get<string>('ML_RANKING_BLEND', '0.3'),
        );
        return Number.isFinite(value) ? Math.min(0.5, Math.max(0, value)) : 0.3;
    }

    // Version model/policy đi vào cache key để đổi artifact không phục vụ nhầm kết quả cũ.
    getMlRankingPolicyVersion(): string {
        if (this.runtimePolicy?.version) return this.runtimePolicy.version;
        return this.config.get<string>(
            'ML_RANKING_POLICY_VERSION',
            'ml-hybrid-v1',
        );
    }

    // Candidate source luôn được thử; ENV chỉ còn là công tắc vận hành khẩn cấp khi một pipeline gặp sự cố.
    isCandidateSourceEnabled(source: 'semantic' | 'coBehavior'): boolean {
        const envKey =
            source === 'semantic'
                ? 'SEMANTIC_CANDIDATES_ENABLED'
                : 'CO_BEHAVIOR_CANDIDATES_ENABLED';
        return (
            this.config.get<string>('CANDIDATE_PIPELINE_V3_ENABLED', 'true') ===
                'true' && this.config.get<string>(envKey, 'true') === 'true'
        );
    }

    // Trả trạng thái read-only của ENV để Admin biết source nào đang bị khóa vận hành, không có quyền override từ policy.
    getCandidateSourceStatus(): {
        semanticEnabled: boolean;
        coBehaviorEnabled: boolean;
        semanticMasterEnabled: boolean;
        coBehaviorMasterEnabled: boolean;
        pipelineMasterEnabled: boolean;
    } {
        const pipelineMasterEnabled =
            this.config.get<string>('CANDIDATE_PIPELINE_V3_ENABLED', 'true') ===
            'true';
        const semanticMasterEnabled =
            this.config.get<string>('SEMANTIC_CANDIDATES_ENABLED', 'true') ===
            'true';
        const coBehaviorMasterEnabled =
            this.config.get<string>(
                'CO_BEHAVIOR_CANDIDATES_ENABLED',
                'true',
            ) === 'true';
        return {
            semanticEnabled: pipelineMasterEnabled && semanticMasterEnabled,
            coBehaviorEnabled: pipelineMasterEnabled && coBehaviorMasterEnabled,
            semanticMasterEnabled,
            coBehaviorMasterEnabled,
            pipelineMasterEnabled,
        };
    }

    // Trả snapshot policy đã chuẩn hóa cho Admin API và bootstrap, không để UI phải suy diễn default từ env.
    getPolicySnapshot(): {
        version: string;
        hybridWeights: HybridRankingWeights;
        mlEnabled: boolean;
        mlBlend: number;
    } {
        return {
            version: this.getRuleVersion(),
            hybridWeights: this.getHybridRankingWeights(),
            mlEnabled: this.isMlRankingEnabled(),
            mlBlend: this.getMlRankingBlend(),
        };
    }

    // Relation scale cấu hình được để purchase/cart/view có ảnh hưởng khác nhau mà không hard-code trong ranker.
    getRelationScoreScale(
        relationType?: 'CO_VIEW' | 'CO_CART' | 'CO_PURCHASE',
    ): number {
        const defaults = { CO_VIEW: 1, CO_CART: 3, CO_PURCHASE: 6 };
        const key = relationType ?? 'CO_VIEW';
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
        surface: 'home' | 'product_detail' | 'recommendations_page',
    ) {
        return surface === 'product_detail'
            ? { category: 2, brand: 2, shop: 3, windowSize: 6 }
            : { category: 4, brand: 3, shop: 5, windowSize: 24 };
    }

    // Đọc một signal weight và giữ đúng dấu nghiệp vụ để config sai không biến return thành positive signal.
    private readSignalWeight(
        configKey: string,
        defaultWeight: number,
        legacyConfigKey?: string,
    ): number {
        const configured =
            this.config.get<string>(configKey) ??
            (legacyConfigKey
                ? this.config.get<string>(legacyConfigKey)
                : undefined);
        const weight =
            configured === undefined ? defaultWeight : Number(configured);
        // Zero cho phép tắt một signal; chỉ cấm đảo dấu positive thành negative hoặc ngược lại.
        const hasExpectedSign =
            weight === 0 ||
            defaultWeight === 0 ||
            Math.sign(weight) === Math.sign(defaultWeight);
        return Number.isFinite(weight) && hasExpectedSign
            ? weight
            : defaultWeight;
    }
}
