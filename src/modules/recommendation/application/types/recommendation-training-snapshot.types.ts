// Contract ghi lại input/output của LambdaRank tại lúc recommendation được phục vụ.
// Snapshot không chứa danh tính actor, hồ sơ thô, nội dung sản phẩm hoặc dữ liệu thanh toán.

import type {
    RecommendationStrategy,
    RecommendationSurface,
} from '@/modules/recommendation/application/types/recommendation.types';
import type {
    RankingFeatureVector,
    RankingMode,
} from '@/modules/recommendation/application/types/ranking/ranking.types';

export const RECOMMENDATION_TRAINING_SNAPSHOT_WRITER = Symbol(
    'RECOMMENDATION_TRAINING_SNAPSHOT_WRITER',
);

export interface RecommendationTrainingCandidateSnapshot {
    productId: string;
    rank: number | null;
    score: number | null;
    features: RankingFeatureVector | null;
    sources: string[];
    categoryId: string | null;
    brandId: string | null;
    sellerShopId: string | null;
    diversityRelaxed: boolean;
}

export interface RecommendationTrainingSourceSnapshot {
    source: string;
    candidateCount: number;
    candidateProductIds: string[];
    truncated: boolean;
}

export interface RecommendationTrainingSnapshot {
    requestId: string;
    servedAt: string;
    featuresComputedAt: string;
    environment: string;
    surface: RecommendationSurface;
    page: number;
    strategy: RecommendationStrategy;
    rankingMode: RankingMode;
    rankingModelVersion: string | null;
    rankingPolicyVersion: string;
    featureSchemaVersion: string;
    candidateBudget: number;
    candidateCount: number;
    selectedCandidateCount: number;
    sourceCandidates: RecommendationTrainingSourceSnapshot[];
    candidates: RecommendationTrainingCandidateSnapshot[];
}

export interface RecommendationTrainingSnapshotCopy {
    sourceRequestId: string;
    requestId: string;
    servedAt: string;
}

export interface RecommendationTrainingSnapshotWriter {
    save(snapshot: RecommendationTrainingSnapshot): Promise<void>;
    copyForServedRequest(
        copy: RecommendationTrainingSnapshotCopy,
    ): Promise<boolean>;
}
