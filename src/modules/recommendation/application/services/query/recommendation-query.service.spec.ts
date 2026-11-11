// Unit tests bảo vệ AI-only serving, attribution và candidate orchestration.
/// <reference types="jest" />

import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { createMock, type DeepMocked } from '@golevelup/ts-jest';
import { RecommendationRedisService } from '@/infrastructure/redis/redis.module';
import { ProfileQueryService } from '@/modules/profiles/application/services/profile/profile-query.service';
import { SessionContextService } from '@/modules/profiles/application/services/session/session-context.service';
import { CandidateGenerationService } from '@/modules/recommendation/application/services/candidates/generation/candidate-generation.service';
import { CandidateUnionService } from '@/modules/recommendation/application/services/candidates/union/candidate-union.service';
import { RecommendationMlRankingService } from '@/modules/recommendation/application/services/ranking/ml/recommendation-ml-ranking.service';
import { RecommendationRankingService } from '@/modules/recommendation/application/services/ranking/policy/recommendation-ranking.service';
import { RecommendationTrackingTokenService } from '@/modules/recommendation/application/services/tracking/attribution/recommendation-tracking-token.service';
import type { RecommendationCatalogProduct } from '@/modules/catalog/application/types/catalog-product.type';
import type { RecommendationCandidate } from '@/modules/recommendation/application/types/ranking/ranking.types';
import { RecommendationQueryService } from '@/modules/recommendation/application/services/query/recommendation-query.service';
import { CatalogService } from '@/modules/catalog/application/services/catalog/catalog.service';
import type { PreferenceValue } from '@/modules/profiles/application/types/profile.types';

class MockLoggerService {
    log(): void {}
    error(): void {}
    warn(): void {}
    debug(): void {}
    verbose(): void {}
    setContext(): void {}
}

describe('RecommendationQueryService', () => {
    let target: RecommendationQueryService;
    let mockProfile: DeepMocked<ProfileQueryService>;
    let mockSession: DeepMocked<SessionContextService>;
    let mockRedis: DeepMocked<RecommendationRedisService>;
    let mockRanking: DeepMocked<RecommendationRankingService>;
    let mockUnionFactory: DeepMocked<CandidateUnionService>;
    let mockCandidates: DeepMocked<CandidateGenerationService>;
    let mockTrackingToken: DeepMocked<RecommendationTrackingTokenService>;
    let mockMlRanking: DeepMocked<RecommendationMlRankingService>;
    let mockCatalog: DeepMocked<CatalogService>;
    let mockUnion: { add: jest.Mock; values: jest.Mock };
    let candidate: RecommendationCandidate;

    beforeEach(async () => {
        mockProfile = createMock<ProfileQueryService>();
        mockSession = createMock<SessionContextService>();
        mockRedis = createMock<RecommendationRedisService>();
        mockRanking = createMock<RecommendationRankingService>();
        mockUnionFactory = createMock<CandidateUnionService>();
        mockCandidates = createMock<CandidateGenerationService>();
        mockTrackingToken = createMock<RecommendationTrackingTokenService>();
        mockMlRanking = createMock<RecommendationMlRankingService>();
        mockCatalog = createMock<CatalogService>();
        mockCatalog.findSnapshots.mockResolvedValue([]);

        const product: RecommendationCatalogProduct = {
            productId: 'product-1',
            name: 'Product 1',
            slug: 'product-1',
            imageUrl: null,
            categoryId: 'category-1',
            brandId: 'brand-1',
            sellerShopId: 'shop-1',
            minPrice: '100',
            maxPrice: '100',
            ratingAvg: '5',
            reviewCount: 10,
            totalSold: 5,
            status: 'ACTIVE',
            isInStock: true,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            updatedAt: new Date('2026-01-01T00:00:00.000Z'),
            catalogVersion: '1',
            shortDescription: null,
            description: null,
            brandName: null,
            categoryPath: null,
            semanticAttributes: [],
            contentHash: null,
            embeddingStatus: 'NOT_REQUIRED',
            embeddingModelVersion: null,
            embeddingDimensions: null,
        };
        candidate = { product, sources: new Set(['TRENDING']) };
        mockUnion = {
            add: jest.fn(),
            values: jest.fn().mockReturnValue([candidate]),
        };
        mockUnionFactory.create.mockReturnValue(mockUnion as never);
        mockCandidates.generate.mockResolvedValue([]);
        mockProfile.getTop.mockResolvedValue([]);
        mockRedis.getVersion.mockResolvedValue(1);
        mockRedis.getJson.mockResolvedValue(null);
        mockRanking.getPolicyVersion.mockReturnValue('ai-lambdarank-test-v1');
        mockRanking.rank.mockReturnValue([{ ...candidate, score: 0.75 }]);
        mockMlRanking.predict.mockResolvedValue({
            scores: new Map([['product-1', 0.75]]),
            features: new Map(),
            modelVersion: 'ranking-lambdarank-test-v1',
        });
        mockTrackingToken.create.mockReturnValue('signed-item-token');

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                RecommendationQueryService,
                {
                    provide: ConfigService,
                    useValue: createMock<ConfigService>(),
                },
                { provide: ProfileQueryService, useValue: mockProfile },
                { provide: SessionContextService, useValue: mockSession },
                { provide: RecommendationRedisService, useValue: mockRedis },
                {
                    provide: RecommendationRankingService,
                    useValue: mockRanking,
                },
                { provide: CandidateUnionService, useValue: mockUnionFactory },
                {
                    provide: CandidateGenerationService,
                    useValue: mockCandidates,
                },
                {
                    provide: RecommendationTrackingTokenService,
                    useValue: mockTrackingToken,
                },
                {
                    provide: RecommendationMlRankingService,
                    useValue: mockMlRanking,
                },
                { provide: CatalogService, useValue: mockCatalog },
            ],
        })
            .setLogger(new MockLoggerService())
            .compile();

        target = module.get<RecommendationQueryService>(
            RecommendationQueryService,
        );
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('should return only the AI model ranking mode and attribution', async () => {
        // Arrange
        const input = { surface: 'home' as const, page: 1, pageSize: 24 };
        const scores = new Map([['product-1', 0.75]]);
        const features = new Map();
        mockMlRanking.predict.mockResolvedValue({
            scores,
            features,
            modelVersion: 'ranking-lambdarank-test-v1',
        });

        // Act
        const result = await target.getRecommendations(input, 'user-1', null);

        // Assert
        expect(result).toMatchObject({
            rankingPolicyVersion: 'ai-lambdarank-test-v1',
            rankingMode: 'AI_MODEL',
            rankingModelVersion: 'ranking-lambdarank-test-v1',
            items: [
                {
                    product: { id: 'product-1' },
                    recommendationItemId: 'signed-item-token',
                },
            ],
        });
        expect(mockRanking.rank).toHaveBeenCalledWith(
            [candidate],
            scores,
            features,
            'home',
        );
        expect(mockTrackingToken.create).toHaveBeenCalledWith(
            expect.objectContaining({ rankingMode: 'AI_MODEL' }),
        );
    });

    // Tổng signed có thể bằng 0 nhưng positiveScore vẫn phải cấp candidate seed và personalized state.
    it('should keep positive profile evidence when signed scores cancel out', async () => {
        // Arrange
        const preferences: Record<string, PreferenceValue[]> = {
            PRODUCT: [
                {
                    actorType: 'USER',
                    actorId: 'user-1',
                    dimension: 'PRODUCT',
                    dimensionKey: 'product-interest',
                    score: 0,
                    positiveScore: 8,
                    negativeScore: 8,
                    interactionCount: 2,
                    lastSignalAt: new Date('2026-11-01T00:00:00.000Z'),
                },
            ],
            CATEGORY: [
                {
                    actorType: 'USER',
                    actorId: 'user-1',
                    dimension: 'CATEGORY',
                    dimensionKey: 'category-interest',
                    score: 0,
                    positiveScore: 8,
                    negativeScore: 8,
                    interactionCount: 2,
                    lastSignalAt: new Date('2026-11-01T00:00:00.000Z'),
                },
            ],
            BRAND: [
                {
                    actorType: 'USER',
                    actorId: 'user-1',
                    dimension: 'BRAND',
                    dimensionKey: 'brand-interest',
                    score: 0,
                    positiveScore: 8,
                    negativeScore: 8,
                    interactionCount: 2,
                    lastSignalAt: new Date('2026-11-01T00:00:00.000Z'),
                },
            ],
        };
        mockProfile.getTop.mockImplementation(
            async (_actorType, _actorId, dimension) =>
                preferences[dimension] ?? [],
        );

        // Act
        const result = await target.getRecommendations(
            { surface: 'home', page: 1, pageSize: 24 },
            'user-1',
            null,
        );

        // Assert
        expect(mockCandidates.generate).toHaveBeenCalledWith(
            expect.objectContaining({
                profileProductIds: ['product-interest'],
                categoryIds: ['category-interest'],
                brandIds: ['brand-interest'],
                strategy: 'PERSONALIZED',
            }),
        );
        expect(result).toMatchObject({
            strategy: 'PERSONALIZED',
            profileState: 'USER',
        });
    });

    // Model lỗi không được đổi sang một ranker deterministic; request phải dừng ở 503.
    it('should fail the request when the AI ranking model is unavailable', async () => {
        // Arrange
        mockMlRanking.predict.mockRejectedValue(
            new ServiceUnavailableException('model unavailable'),
        );
        const input = { surface: 'home' as const, page: 1, pageSize: 24 };

        // Act / Assert
        await expect(
            target.getRecommendations(input, 'user-1', null),
        ).rejects.toThrow(ServiceUnavailableException);
        expect(mockRanking.rank).not.toHaveBeenCalled();
        expect(mockRedis.setJson).not.toHaveBeenCalled();
        expect(mockMlRanking.predict).toHaveBeenCalledTimes(1);
    });

    // Contract version mới tách cache cũ để không trả lại score Standard đã lưu trước đây.
    it('should use a new cache contract for model-only responses', async () => {
        // Arrange
        const input = { surface: 'home' as const, page: 1, pageSize: 24 };

        // Act
        await target.getRecommendations(input, 'user-1', null);

        // Assert
        expect(mockRedis.getJson).toHaveBeenCalledWith(
            expect.stringContaining('recommendation:contract-v8:'),
        );
    });

    // Đảm bảo home vẫn dùng ba sản phẩm gần đây làm anchor dù không loại chúng khỏi candidate pool.
    it('should keep recent products as anchors instead of excluding them on home', async () => {
        // Arrange
        mockSession.get.mockResolvedValue({
            recentProductIds: ['recent-1', 'recent-2', 'recent-3'],
            recentProductSignals: [],
            recentCategoryIds: [],
            recentBrandIds: [],
        } as never);
        const input = { surface: 'home' as const, page: 1, pageSize: 24 };

        // Act
        await target.getRecommendations(input, null, 'session-1');

        // Assert
        expect(mockCandidates.generate).toHaveBeenCalledWith(
            expect.objectContaining({
                excludedProductIds: [],
                recentProductIds: ['recent-1', 'recent-2', 'recent-3'],
            }),
        );
    });

    // Đảm bảo detail chỉ loại self/shop và vẫn trả page size 24 cho carousel recommendation.
    it('should exclude the current product and its shop on product detail', async () => {
        // Arrange
        mockCatalog.findSnapshots.mockResolvedValue([
            { sellerShopId: 'shop-1' } as never,
        ]);
        const input = {
            surface: 'product_detail' as const,
            productId: 'product-1',
            page: 1,
            pageSize: 24,
        };

        // Act
        const result = await target.getRecommendations(input, 'user-1', null);

        // Assert
        expect(result.pageSize).toBe(24);
        expect(mockUnionFactory.create).toHaveBeenCalledWith(
            ['product-1'],
            300,
            { excludeSellerShopId: 'shop-1' },
        );
        expect(mockCandidates.generate).toHaveBeenCalledWith(
            expect.objectContaining({
                excludedProductIds: ['product-1'],
                excludedSellerShopId: 'shop-1',
                recentProductIds: [],
            }),
        );
    });
});
