// Service này là adapter application tới AI Service; chỉ gửi feature vector đã normalize, không gửi catalog text hay dữ liệu user.

import {
    Injectable,
    Logger,
    ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type {
    PreferenceValue,
    SessionContext,
} from '@/modules/profiles/application/types/profile.types';
import type {
    RankingFeatureVector,
    RecommendationCandidate,
} from '@/modules/recommendation/application/types/ranking/ranking.types';
import {
    RankingFeatureService,
    type RankingPreferenceLookup,
} from '@/modules/recommendation/application/services/ranking/features/ranking-feature.service';

const FEATURE_ORDER: Array<keyof RankingFeatureVector> = [
    'profileAffinity',
    'sessionContext',
    'semanticSimilarity',
    'coBehavior',
    'popularity',
    'freshness',
    'quality',
    'exploration',
    'negativePenalty',
];

export interface RecommendationMlRankingResult {
    scores: ReadonlyMap<string, number>;
    features: ReadonlyMap<string, RankingFeatureVector>;
    modelVersion: string | null;
}

export interface RecommendationMlRankingStatus {
    ready: boolean;
    modelVersion: string | null;
    featureCount: number | null;
    reachable: boolean;
}

@Injectable()
export class RecommendationMlRankingService {
    private readonly logger = new Logger(RecommendationMlRankingService.name);
    private readonly baseUrl: string;
    private readonly token: string;
    private readonly timeoutMs: number;
    private readonly logScores: boolean;

    constructor(
        private readonly config: ConfigService,
        private readonly features: RankingFeatureService,
    ) {
        this.baseUrl = config
            .get<string>('AI_SERVICE_URL', 'http://localhost:3009')
            .replace(/\/$/, '');
        this.token = config.get<string>('INTERNAL_SERVICE_TOKEN', '');
        const configuredTimeout = Number(
            config.get<string>('ML_RANKING_TIMEOUT_MS', '150'),
        );
        this.timeoutMs =
            Number.isInteger(configuredTimeout) && configuredTimeout > 0
                ? Math.min(configuredTimeout, 1000)
                : 150;
        this.logScores =
            config.get<string>('ML_RANKING_LOG_SCORES', 'false') === 'true';
    }

    // Đọc trạng thái artifact qua boundary nội bộ để Admin biết ranker đã sẵn sàng hay chưa.
    async getStatus(): Promise<RecommendationMlRankingStatus> {
        if (!this.token) {
            return {
                ready: false,
                modelVersion: null,
                featureCount: null,
                reachable: false,
            };
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response = await fetch(
                `${this.baseUrl}/api/v1/ranking/status`,
                {
                    headers: { 'x-internal-service-token': this.token },
                    signal: controller.signal,
                },
            );
            if (!response.ok)
                throw new Error(`AI_RANKING_STATUS_HTTP_${response.status}`);
            const payload = (await response.json()) as {
                ready?: unknown;
                modelVersion?: unknown;
                featureCount?: unknown;
            };
            return {
                ready: payload.ready === true,
                modelVersion:
                    typeof payload.modelVersion === 'string'
                        ? payload.modelVersion
                        : null,
                featureCount:
                    typeof payload.featureCount === 'number'
                        ? payload.featureCount
                        : null,
                reachable: true,
            };
        } catch (error) {
            this.logger.warn(
                `ML ranking status unavailable: ${this.errorMessage(error)}`,
            );
            return {
                ready: false,
                modelVersion: null,
                featureCount: null,
                reachable: false,
            };
        } finally {
            clearTimeout(timer);
        }
    }

    // Gọi batch LambdaRank; lỗi hoặc model chưa sẵn sàng làm request dừng thay vì tạo score thay thế.
    async predict(input: {
        requestId: string;
        candidates: RecommendationCandidate[];
        products: PreferenceValue[];
        categories: PreferenceValue[];
        brands: PreferenceValue[];
        context: SessionContext | null;
    }): Promise<RecommendationMlRankingResult> {
        if (input.candidates.length === 0) {
            return {
                scores: new Map(),
                features: new Map(),
                modelVersion: null,
            };
        }
        if (!this.token) {
            throw new ServiceUnavailableException(
                'RANKING_MODEL_SERVICE_NOT_CONFIGURED',
            );
        }

        const candidates = input.candidates.slice(0, 300);
        const featureByProductId = new Map<string, RankingFeatureVector>();
        const preferenceLookup = this.features.createPreferenceLookup(
            input.products,
            input.categories,
            input.brands,
        );
        // Dùng chung mốc giờ cho toàn candidate để tuổi preference không đổi theo thứ tự vòng lặp.
        const referenceTime = new Date();
        const items = candidates.map((candidate) => ({
            itemId: candidate.product.productId,
            features: this.toFeatureRow(
                this.buildFeatures(
                    candidate,
                    input,
                    featureByProductId,
                    preferenceLookup,
                    referenceTime,
                ),
            ),
        }));
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response = await fetch(
                `${this.baseUrl}/api/v1/ranking/predict`,
                {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'x-internal-service-token': this.token,
                    },
                    body: JSON.stringify({
                        requestId: input.requestId || randomUUID(),
                        items,
                    }),
                    signal: controller.signal,
                },
            );
            if (!response.ok)
                throw new Error(`AI_RANKING_HTTP_${response.status}`);
            const payload = (await response.json()) as {
                modelVersion?: unknown;
                predictions?: unknown;
            };
            if (!Array.isArray(payload.predictions))
                throw new Error('AI_RANKING_INVALID_RESPONSE');
            const allowed = new Set(
                candidates.map((candidate) => candidate.product.productId),
            );
            const scores = new Map<string, number>();
            for (const prediction of payload.predictions) {
                if (!this.isPrediction(prediction)) continue;
                const itemId = prediction.itemId.trim();
                if (!allowed.has(itemId)) continue;
                // Duplicate item phá tính một-score-mỗi-candidate nên hủy toàn bộ batch.
                if (scores.has(itemId))
                    throw new Error('AI_RANKING_DUPLICATE_ITEM');
                scores.set(itemId, prediction.score);
            }
            // Model phải trả đúng mọi candidate trong request; không trộn batch hợp lệ với điểm thiếu.
            if (scores.size !== candidates.length) {
                throw new Error('AI_RANKING_INCOMPLETE_RESPONSE');
            }
            const modelVersion =
                typeof payload.modelVersion === 'string' &&
                payload.modelVersion.trim().length > 0
                    ? payload.modelVersion.trim()
                    : null;
            // Registry từ chối fallback; version rỗng đồng nghĩa output không thể attribue thành ranking model.
            if (!modelVersion || modelVersion.startsWith('ranking-fallback')) {
                throw new Error('AI_RANKING_MODEL_VERSION_MISSING');
            }
            this.logPredictionScores(
                input.requestId,
                modelVersion,
                candidates,
                scores,
            );
            return {
                scores,
                features: featureByProductId,
                modelVersion: scores.size > 0 ? modelVersion : null,
            };
        } catch (error) {
            this.logger.warn(
                `LambdaRank unavailable: ${this.errorMessage(error)}`,
            );
            throw new ServiceUnavailableException(
                'RECOMMENDATION_RANKING_MODEL_UNAVAILABLE',
            );
        } finally {
            clearTimeout(timer);
        }
    }

    // Giữ thứ tự feature cố định giữa Recommendation và AI để artifact không bị lệch cột khi refactor code.
    private toFeatureRow(features: RankingFeatureVector): number[] {
        return FEATURE_ORDER.map((key) => this.clamp(features[key]));
    }

    // Log raw relevance score ở local để đối chiếu candidate sau khi toàn batch đã được xác thực.
    private logPredictionScores(
        requestId: string,
        modelVersion: string,
        candidates: RecommendationCandidate[],
        scores: ReadonlyMap<string, number>,
    ): void {
        if (!this.logScores) return;
        for (const candidate of candidates) {
            const productId = candidate.product.productId;
            const score = scores.get(productId);
            if (score === undefined) continue;
            this.logger.log(
                `[ML_RANKING_SCORE] requestId=${requestId} modelVersion=${modelVersion} itemId=${productId} productName=${JSON.stringify(candidate.product.name)} mlScore=${score.toFixed(6)}`,
            );
        }
    }

    // Cache feature vector trong batch để không tính lại preference/semantic relation sau khi model phản hồi.
    private buildFeatures(
        candidate: RecommendationCandidate,
        input: {
            products: PreferenceValue[];
            categories: PreferenceValue[];
            brands: PreferenceValue[];
            context: SessionContext | null;
        },
        target: Map<string, RankingFeatureVector>,
        lookup: RankingPreferenceLookup,
        referenceTime: Date,
    ): RankingFeatureVector {
        const features = this.features.build(
            candidate,
            input.products,
            input.categories,
            input.brands,
            input.context,
            lookup,
            referenceTime,
        );
        target.set(candidate.product.productId, features);
        return features;
    }

    // Chỉ nhận raw prediction hữu hạn; không clamp về xác suất vì LambdaRank score không phải xác suất.
    private isPrediction(
        value: unknown,
    ): value is { itemId: string; score: number } {
        if (!value || typeof value !== 'object') return false;
        const item = value as { itemId?: unknown; score?: unknown };
        return (
            typeof item.itemId === 'string' &&
            item.itemId.trim().length > 0 &&
            typeof item.score === 'number' &&
            Number.isFinite(item.score)
        );
    }

    // Clamp chỉ áp dụng cho feature đầu vào; model score được giữ nguyên để so thứ tự.
    private clamp(value: number): number {
        return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
    }

    private errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : 'unknown error';
    }
}
