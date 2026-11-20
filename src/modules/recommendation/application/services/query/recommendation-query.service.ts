// Service này điều phối recommendation request: đọc context/profile, gom candidate, cache và phân trang; ranking nằm ở policy riêng.

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { ProfileQueryService } from '@/modules/profiles/application/services/profile/profile-query.service';
import { SessionContextService } from '@/modules/profiles/application/services/session/session-context.service';
import { RecommendationRedisService } from '@/infrastructure/redis/redis.module';
import type { RecommendationQueryDto } from '@/modules/recommendation/presentation/dto/recommendation-query.dto';
import type {
    RecommendationItemResponse,
    RecommendationResponse,
    RecommendationStrategy,
} from '@/modules/recommendation/application/types/recommendation.types';
import { RecommendationRankingService } from '@/modules/recommendation/application/services/ranking/policy/recommendation-ranking.service';
import type {
    RecommendationCandidate,
    RankingMode,
} from '@/modules/recommendation/application/types/ranking/ranking.types';
import { RECOMMENDATION_FEATURE_SCHEMA_VERSION } from '@/modules/recommendation/application/types/ranking/ranking.types';
import { CandidateUnionService } from '@/modules/recommendation/application/services/candidates/union/candidate-union.service';
import { CandidateGenerationService } from '@/modules/recommendation/application/services/candidates/generation/candidate-generation.service';
import type { CandidateSourceResult } from '@/modules/recommendation/application/types/candidates/candidate-source.types';
import { RecommendationTrackingTokenService } from '@/modules/recommendation/application/services/tracking/attribution/recommendation-tracking-token.service';
import { RecommendationMlRankingService } from '@/modules/recommendation/application/services/ranking/ml/recommendation-ml-ranking.service';
import { CatalogService } from '@/modules/catalog/application/services/catalog/catalog.service';
import type { RecommendationCatalogProduct } from '@/modules/catalog/application/types/catalog-product.type';
import {
    RECOMMENDATION_TRAINING_SNAPSHOT_WRITER,
    type RecommendationTrainingSnapshot,
    type RecommendationTrainingSnapshotCopy,
    type RecommendationTrainingSnapshotWriter,
} from '@/modules/recommendation/application/types/recommendation-training-snapshot.types';

const CANDIDATE_POOL_BUDGET = 300;
const SOURCE_SNAPSHOT_ID_LIMIT = 300;

@Injectable()
// Service điều phối request và snapshot point-in-time; writer là adapter optional để test/unit không phụ thuộc PostgreSQL.
export class RecommendationQueryService {
    private readonly logger = new Logger(RecommendationQueryService.name);
    private readonly cacheTtlSeconds: number;
    private readonly trainingSnapshotCaptureEnabled: boolean;

    // Đọc chính sách capture và cache một lần lúc khởi tạo để request path không đổi cấu hình giữa chừng.
    constructor(
        private readonly config: ConfigService,
        private readonly profile: ProfileQueryService,
        private readonly session: SessionContextService,
        private readonly redis: RecommendationRedisService,
        private readonly ranking: RecommendationRankingService,
        private readonly unionFactory: CandidateUnionService,
        private readonly candidates: CandidateGenerationService,
        private readonly trackingToken: RecommendationTrackingTokenService,
        private readonly mlRanking: RecommendationMlRankingService,
        private readonly catalog: CatalogService,
        @Optional()
        @Inject(RECOMMENDATION_TRAINING_SNAPSHOT_WRITER)
        private readonly trainingSnapshotWriter?: RecommendationTrainingSnapshotWriter,
    ) {
        const configuredSnapshotCapture = this.config.get<string>(
            'RECOMMENDATION_TRAINING_SNAPSHOT_ENABLED',
        );
        // Kubernetes production hiện chỉ truyền NODE_ENV; mặc định bật pilot ở prod và tắt ở local/dev.
        // Giá trị tường minh luôn ưu tiên để operator có kill switch khi cần dừng capture.
        this.trainingSnapshotCaptureEnabled =
            configuredSnapshotCapture === undefined
                ? this.config.get<string>('NODE_ENV', 'development') ===
                  'production'
                : configuredSnapshotCapture === 'true';
        const configuredTtl = Number(
            this.config.get<string>('RECOMMENDATION_CACHE_TTL_SECONDS', '300'),
        );
        this.cacheTtlSeconds = Number.isFinite(configuredTtl)
            ? Math.min(Math.max(Math.trunc(configuredTtl), 30), 3600)
            : 300;
    }

    // Trả recommendation và ghi snapshot trước khi cache; cache hit clone snapshot với request ID riêng để event join chính xác.
    async getRecommendations(
        input: RecommendationQueryDto,
        userId: string | null,
        sessionId: string | null,
    ): Promise<RecommendationResponse> {
        const actorType = userId ? 'user' : 'session';
        const actorId = userId ?? sessionId ?? 'anonymous';
        const pageSize =
            input.surface === 'product_detail'
                ? Math.min(input.pageSize, 24)
                : input.pageSize;
        // Mọi response mới dùng LambdaRank; model thiếu/lỗi được xử lý 503 trong adapter, không đổi mode.
        const mode: RankingMode = 'AI_MODEL';
        const policyVersion = this.ranking.getPolicyVersion();
        const [globalVersion, actorVersion] = await Promise.all([
            this.redis.getVersion('recommendation:cache-version:global'),
            this.redis.getVersion(
                `recommendation:cache-version:${actorType}:${actorId}`,
            ),
        ]);
        const ruleVersion = encodeURIComponent(policyVersion);
        // Tách cache có snapshot khỏi cache không có snapshot nguồn.
        // Khi bật lại capture, request mới sẽ không dùng slate cũ thiếu attribution.
        const snapshotCacheNamespace =
            this.trainingSnapshotCaptureEnabled && this.trainingSnapshotWriter
                ? 'snapshot-v1'
                : 'snapshot-disabled';
        const cacheKey = `recommendation:contract-v8:v${globalVersion}:r${ruleVersion}:m${mode}:a${actorVersion}:${actorType}:${actorId}:${sessionId ?? 'none'}:${input.surface}:${input.productId ?? 'none'}:${input.page}:${pageSize}:${snapshotCacheNamespace}`;
        const cached =
            await this.redis.getJson<RecommendationResponse>(cacheKey);
        if (cached) {
            // Cache format có suffix snapshot-v1 để slate cũ không bị dùng mà thiếu snapshot nguồn.
            const refreshed = this.refreshCachedResponse(
                cached,
                actorId,
                input.surface,
            );
            await this.copyTrainingSnapshot(refreshed.snapshotCopy);
            return refreshed.response;
        }

        const context = sessionId ? await this.session.get(sessionId) : null;
        const result = await this.buildResponse(
            input,
            userId,
            sessionId,
            context,
            pageSize,
            mode,
        );
        const snapshotSaved = await this.saveTrainingSnapshot(result.snapshot);
        // Không tạo cache mới nếu snapshot chưa được lưu; request kế tiếp thử lại thay vì tái dùng slate không có dữ liệu train.
        if (snapshotSaved) {
            await this.redis.setJson(
                cacheKey,
                result.response,
                this.cacheTtlSeconds,
            );
        }
        return result.response;
    }

    // Cache giữ API response nhỏ; mỗi hit nhận request ID mới và copy snapshot gốc trong PostgreSQL với servedAt riêng.
    private refreshCachedResponse(
        cached: RecommendationResponse,
        actorId: string,
        surface: RecommendationQueryDto['surface'],
    ): {
        response: RecommendationResponse;
        snapshotCopy: RecommendationTrainingSnapshotCopy;
    } {
        const requestId = randomUUID();
        const rankingMode: RankingMode = 'AI_MODEL';
        const servedAt = new Date().toISOString();
        const response = {
            ...cached,
            requestId,
            generatedAt: servedAt,
            // contract-v8 tách cache theo semantics profile và feature schema mới để response v7 không sống lại.
            rankingMode,
            rankingModelVersion: cached.rankingModelVersion ?? null,
            items: cached.items.map((item) => ({
                ...item,
                recommendationItemId: this.trackingToken.create({
                    actorId,
                    requestId,
                    productId: item.product.id,
                    rank: item.rank,
                    source: item.source,
                    surface,
                    policyVersion:
                        cached.rankingPolicyVersion ??
                        this.ranking.getPolicyVersion(),
                    rankingMode,
                }),
            })),
        };
        return {
            response,
            snapshotCopy: {
                sourceRequestId: cached.requestId,
                requestId,
                servedAt,
            },
        };
    }

    // Gom source candidate bằng các query song song; duplicate product chỉ giữ một read model và hợp nhất source để explainability.
    // Với product detail, snapshot được đọc trước để xác định đúng namespace shop rồi truyền exclusion xuống từng source và union.
    // Với home/recommendations_page, recentProductIds không bị loại vì chúng vẫn là anchor cho semantic/co-behavior ranking.
    // Lỗi ghi snapshot không làm hỏng serving; source lỗi vẫn được giữ theo fail-soft của CandidateGenerationService.
    private async buildResponse(
        input: RecommendationQueryDto,
        userId: string | null,
        sessionId: string | null,
        context: Awaited<ReturnType<SessionContextService['get']>>,
        pageSize: number,
        mode: RankingMode,
    ): Promise<{
        response: RecommendationResponse;
        snapshot: RecommendationTrainingSnapshot;
    }> {
        const actorType = userId ? 'USER' : 'SESSION';
        const actorId = userId ?? sessionId ?? 'anonymous';
        const [productPreferences, categoryPreferences, brandPreferences] =
            await Promise.all([
                this.profile.getTop(actorType, actorId, 'PRODUCT', 30),
                this.profile.getTop(actorType, actorId, 'CATEGORY', 12),
                this.profile.getTop(actorType, actorId, 'BRAND', 12),
            ]);
        // Dùng cùng thành phần dương mà feature đọc; signed score có thể bằng 0 dù người dùng vẫn có bằng chứng quan tâm.
        const hasPositiveProfileSignal = [
            ...productPreferences,
            ...categoryPreferences,
            ...brandPreferences,
        ].some((item) => item.positiveScore > 0);
        const profileProductIds = productPreferences
            .filter((item) => item.positiveScore > 0)
            .map((item) => item.dimensionKey);
        const categoryIds = [
            ...new Set([
                ...categoryPreferences
                    .filter((item) => item.positiveScore > 0)
                    .map((item) => item.dimensionKey),
                ...(context?.recentCategoryIds ?? []),
            ]),
        ].filter(Boolean);
        const brandIds = [
            ...new Set([
                ...brandPreferences
                    .filter((item) => item.positiveScore > 0)
                    .map((item) => item.dimensionKey),
                ...(context?.recentBrandIds ?? []),
            ]),
        ].filter(Boolean);
        // Recent products là anchor để tìm semantic/co-behavior, không phải exclusion mặc định;
        // chỉ product đang mở bị loại ở product detail để tránh lặp chính nó trên carousel.
        const excluded = new Set(
            (input.surface === 'product_detail'
                ? [input.productId]
                : []
            ).filter(Boolean) as string[],
        );
        let currentProduct: RecommendationCatalogProduct | null = null;
        if (input.surface === 'product_detail' && input.productId) {
            try {
                currentProduct =
                    (await this.catalog.findSnapshots([input.productId]))[0] ??
                    null;
            } catch {
                // Snapshot lỗi chỉ bỏ shop exclusion; exclusion productId vẫn giữ để recommendation không lặp chính sản phẩm.
                currentProduct = null;
            }
        }
        const shopExclusions = {
            ...(currentProduct?.sellerShopId
                ? { excludeSellerShopId: currentProduct.sellerShopId }
                : {}),
        };
        const strategy: RecommendationStrategy = hasPositiveProfileSignal
            ? 'PERSONALIZED'
            : context
              ? 'SESSION_BASED'
              : 'COLD_START';

        const union = this.unionFactory.create(
            [...excluded],
            CANDIDATE_POOL_BUDGET,
            shopExclusions,
        );
        const sourceResults = await this.candidates.generate({
            productId: input.productId,
            excludedProductIds: [...excluded],
            excludedSellerShopId: shopExclusions.excludeSellerShopId,
            profileProductIds,
            categoryIds,
            brandIds,
            recentProductIds: context?.recentProductIds ?? [],
            recentProductSignals: context?.recentProductSignals ?? [],
            strategy,
        });
        for (const result of sourceResults) this.addSource(union, result);

        // Giới hạn candidate union trước ranking để request miss không làm phình CPU/DB khi nhiều source cùng trả dữ liệu.
        const candidatePool = union.values();
        const requestId = randomUUID();
        const mlResult = await this.mlRanking.predict({
            requestId,
            candidates: candidatePool,
            products: productPreferences,
            categories: categoryPreferences,
            brands: brandPreferences,
            context,
        });
        const diversified = this.ranking.rank(
            candidatePool,
            mlResult.scores,
            mlResult.features,
            input.surface,
        );
        const total = diversified.length;
        const start = (input.page - 1) * pageSize;
        const pageItems = diversified.slice(start, start + pageSize);
        const servedAt = new Date().toISOString();
        const rankingPolicyVersion = this.ranking.getPolicyVersion();
        const response: RecommendationResponse = {
            requestId,
            strategy,
            // Negative/returned signals vẫn được lưu để tránh gợi ý sai,
            // nhưng không có nghĩa user đã có positive preference để gọi là personalized.
            profileState: userId
                ? hasPositiveProfileSignal
                    ? 'USER'
                    : 'NEW_USER'
                : 'GUEST',
            items: pageItems.map((item, index) =>
                this.toResponseItem(
                    item,
                    start + index + 1,
                    requestId,
                    actorId,
                    input.surface,
                    mode,
                ),
            ),
            page: input.page,
            pageSize,
            total,
            totalPages: total === 0 ? 1 : Math.ceil(total / pageSize),
            generatedAt: servedAt,
            ruleVersion: rankingPolicyVersion,
            rankingPolicyVersion,
            rankingMode: mode,
            rankingModelVersion: mlResult.modelVersion,
        };
        const selectedByProductId = new Map(
            diversified.map((item, index) => [
                item.product.productId,
                { item, rank: index + 1 },
            ]),
        );
        const snapshot: RecommendationTrainingSnapshot = {
            requestId,
            servedAt,
            featuresComputedAt: mlResult.featuresComputedAt,
            environment: this.config.get<string>('NODE_ENV', 'unknown'),
            surface: input.surface,
            page: input.page,
            strategy,
            rankingMode: mode,
            rankingModelVersion: mlResult.modelVersion,
            rankingPolicyVersion,
            featureSchemaVersion: RECOMMENDATION_FEATURE_SCHEMA_VERSION,
            candidateBudget: CANDIDATE_POOL_BUDGET,
            candidateCount: candidatePool.length,
            selectedCandidateCount: diversified.length,
            sourceCandidates: sourceResults.map((result) => ({
                source: result.source,
                candidateCount: result.products.length,
                candidateProductIds: result.products
                    .slice(0, SOURCE_SNAPSHOT_ID_LIMIT)
                    .map((product) => product.productId),
                truncated: result.products.length > SOURCE_SNAPSHOT_ID_LIMIT,
            })),
            candidates: candidatePool.map((candidate) => {
                const productId = candidate.product.productId;
                const selected = selectedByProductId.get(productId);
                return {
                    productId,
                    rank: selected?.rank ?? null,
                    score: mlResult.scores.get(productId) ?? null,
                    features: mlResult.features.get(productId) ?? null,
                    sources: [...candidate.sources].sort(),
                    categoryId: candidate.product.categoryId,
                    brandId: candidate.product.brandId,
                    sellerShopId: candidate.product.sellerShopId,
                    diversityRelaxed: selected?.item.diversityRelaxed ?? false,
                };
            }),
        };
        return { response, snapshot };
    }

    // Lưu đầy đủ feature/input snapshot trước khi đưa response vào cache để cache hit sau này luôn có row nguồn để clone.
    private async saveTrainingSnapshot(
        snapshot: RecommendationTrainingSnapshot,
    ): Promise<boolean> {
        if (
            !this.trainingSnapshotCaptureEnabled ||
            !this.trainingSnapshotWriter
        ) {
            return true;
        }
        try {
            await this.trainingSnapshotWriter.save(snapshot);
            return true;
        } catch (error) {
            const errorType = error instanceof Error ? error.name : 'unknown';
            this.logger.warn(
                `Recommendation training snapshot save failed requestId=${snapshot.requestId} errorType=${errorType}`,
            );
            return false;
        }
    }

    // Cache slate chỉ được tái dùng nếu snapshot nguồn đã có; mọi lỗi telemetry được ghi nhận nhưng không chặn người mua.
    private async copyTrainingSnapshot(
        copy: RecommendationTrainingSnapshotCopy,
    ): Promise<void> {
        if (
            !this.trainingSnapshotCaptureEnabled ||
            !this.trainingSnapshotWriter
        ) {
            return;
        }
        try {
            const copied =
                await this.trainingSnapshotWriter.copyForServedRequest(copy);
            if (!copied) {
                this.logger.warn(
                    `Recommendation training snapshot source missing requestId=${copy.requestId}`,
                );
            }
        } catch (error) {
            const errorType = error instanceof Error ? error.name : 'unknown';
            this.logger.warn(
                `Recommendation training snapshot copy failed requestId=${copy.requestId} errorType=${errorType}`,
            );
        }
    }

    // Dua ket qua source vao union tai mot diem duy nhat de query service chi con dieu phoi response/pagination.
    private addSource(
        union: ReturnType<CandidateUnionService['create']>,
        result: CandidateSourceResult,
    ): void {
        union.add(
            result.products,
            result.source,
            result.contributionByProductId,
        );
    }

    // Chuyển read model thành product card contract và hiển thị reason theo source mạnh nhất; raw score vẫn giữ cho debug/UI hiện tại.
    private toResponseItem(
        item: RecommendationCandidate & { score: number },
        rank: number,
        requestId: string,
        actorId: string,
        surface: RecommendationQueryDto['surface'],
        mode: RankingMode,
    ): RecommendationItemResponse {
        const sourcePriority = [
            'PRODUCT_AFFINITY',
            'CATEGORY_AFFINITY',
            'BRAND_AFFINITY',
            'CO_BEHAVIOR',
            'SEMANTIC_SIMILARITY',
            'TRENDING',
            'BEST_SELLING',
            'NEWEST',
            'EXPLORE',
        ];
        const source =
            sourcePriority.find((candidateSource) =>
                item.sources.has(candidateSource),
            ) ?? 'EXPLORE';
        const reasonBySource: Record<string, string> = {
            PRODUCT_AFFINITY: 'Dựa trên sản phẩm bạn từng quan tâm',
            CATEGORY_AFFINITY: 'Phù hợp với danh mục bạn đang quan tâm',
            BRAND_AFFINITY: 'Được chọn theo thương hiệu bạn yêu thích',
            TRENDING: 'Đang được nhiều người quan tâm',
            BEST_SELLING: 'Được nhiều khách hàng lựa chọn',
            NEWEST: 'Sản phẩm mới đáng để khám phá',
            EXPLORE: 'Một lựa chọn mới để bạn khám phá',
            SEMANTIC_SIMILARITY:
                'Có nội dung tương đồng với sản phẩm bạn quan tâm',
            CO_BEHAVIOR: 'Được chọn từ hành vi mua sắm tương tự',
        };
        return {
            product: {
                id: item.product.productId,
                name: item.product.name,
                slug: item.product.slug,
                sellerShopId: item.product.sellerShopId,
                categoryId: item.product.categoryId,
                minPrice: item.product.minPrice,
                maxPrice: item.product.maxPrice,
                displayPrice: item.product.minPrice,
                displayOriginalPrice: null,
                totalSold: item.product.totalSold,
                ratingAvg: item.product.ratingAvg,
                reviewCount: item.product.reviewCount,
                images: item.product.imageUrl
                    ? [
                          {
                              id: `${item.product.productId}-thumbnail`,
                              imageUrl: item.product.imageUrl,
                              sortOrder: 0,
                              isThumbnail: true,
                          },
                      ]
                    : [],
                brand: null,
            },
            recommendationItemId: this.trackingToken.create({
                actorId,
                requestId,
                productId: item.product.productId,
                rank,
                source,
                surface,
                policyVersion: this.ranking.getPolicyVersion(),
                rankingMode: mode,
            }),
            rank,
            score: Number(item.score.toFixed(6)),
            source,
            reasons: [
                reasonBySource[source] ?? 'Một lựa chọn đáng để bạn khám phá',
            ],
        };
    }
}
