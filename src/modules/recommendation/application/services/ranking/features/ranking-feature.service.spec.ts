// Unit test cho feature vector Phase 4; bảo vệ việc tách semantic/co-behavior khỏi tín hiệu catalog thông thường.

import { Test, type TestingModule } from '@nestjs/testing';
import { createMock, type DeepMocked } from '@golevelup/ts-jest';
import { RecommendationRuleService } from '@/modules/profiles/application/services/rules/recommendation-rule.service';
import type { PreferenceValue } from '@/modules/profiles/application/types/profile.types';
import type { RecommendationCatalogProduct } from '@/modules/catalog/application/types/catalog-product.type';
import { RankingFeatureService } from '@/modules/recommendation/application/services/ranking/features/ranking-feature.service';
import type { RecommendationCandidate } from '@/modules/recommendation/application/types/ranking/ranking.types';

class MockLoggerService {
    log(): void {}
    error(): void {}
    warn(): void {}
    debug(): void {}
    verbose(): void {}
    setContext(): void {}
}

describe('RankingFeatureService', () => {
    let target: RankingFeatureService;
    let mockRules: DeepMocked<RecommendationRuleService>;

    // Tạo catalog fixture đầy đủ để test chỉ tập trung vào feature cần kiểm tra.
    const createProduct = (): RecommendationCatalogProduct => ({
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
        reviewCount: 100,
        totalSold: 10,
        status: 'ACTIVE',
        isInStock: true,
        createdAt: new Date(),
        updatedAt: new Date(),
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
    });

    // Tạo candidate có attribution tùy biến để kiểm tra normalization theo đúng source.
    const createCandidate = (
        contributions: NonNullable<RecommendationCandidate['contributions']>,
    ): RecommendationCandidate => ({
        product: createProduct(),
        sources: new Set(contributions.map((item) => item.source)),
        contributions,
    });

    // Giữ timestamp và tổng dương/âm độc lập để test kiểm tra đúng contract của projection mới.
    const createPreference = (
        dimension: PreferenceValue['dimension'],
        dimensionKey: string,
        positiveScore: number,
        negativeScore: number,
        lastSignalAt: Date,
    ): PreferenceValue => ({
        actorType: 'USER',
        actorId: 'user-1',
        dimension,
        dimensionKey,
        score: positiveScore - negativeScore,
        positiveScore,
        negativeScore,
        interactionCount: 2,
        lastSignalAt,
    });

    beforeEach(async () => {
        mockRules = createMock<RecommendationRuleService>();
        mockRules.getProfileHalfLifeDays.mockReturnValue(7);
        mockRules.getProfileAffinityConfig.mockReturnValue({
            product: { weight: 0.5, scale: 8 },
            category: { weight: 0.3, scale: 16 },
            brand: { weight: 0.2, scale: 8 },
        });
        mockRules.getRelationScoreScale.mockImplementation((relationType) =>
            relationType === 'CO_PURCHASE' ? 6 : 1,
        );

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                RankingFeatureService,
                { provide: RecommendationRuleService, useValue: mockRules },
            ],
        })
            .setLogger(new MockLoggerService())
            .compile();

        target = module.get<RankingFeatureService>(RankingFeatureService);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('build', () => {
        it('should ignore non co-behavior contributions when calculating co-behavior', () => {
            // Arrange
            const candidate = createCandidate([
                {
                    source: 'CATEGORY_AFFINITY',
                    rawScore: 100,
                    reasonCode: 'MATCHED_CATEGORY',
                    relationType: 'CO_PURCHASE',
                },
            ]);

            // Act
            const result = target.build(candidate, [], [], [], null);

            // Assert
            expect(result.coBehavior).toBe(0);
            expect(mockRules.getRelationScoreScale).not.toHaveBeenCalled();
        });

        it('should normalize co-purchase relation with its configured scale', () => {
            // Arrange
            const candidate = createCandidate([
                {
                    source: 'CO_BEHAVIOR',
                    rawScore: 6,
                    reasonCode: 'CO_PURCHASE',
                    relationType: 'CO_PURCHASE',
                },
            ]);

            // Act
            const result = target.build(candidate, [], [], [], null);

            // Assert
            expect(result.coBehavior).toBeCloseTo(0.5);
            expect(mockRules.getRelationScoreScale).toHaveBeenCalledWith(
                'CO_PURCHASE',
            );
            expect(mockRules.getRelationScoreScale).toHaveBeenCalledTimes(1);
        });

        it('should decay a negative preference before applying the penalty', () => {
            // Arrange
            const candidate = createCandidate([]);
            const negativePreference: PreferenceValue = {
                actorType: 'USER',
                actorId: 'user-1',
                dimension: 'PRODUCT',
                dimensionKey: 'product-1',
                score: -8,
                positiveScore: 0,
                negativeScore: 8,
                interactionCount: 1,
                lastSignalAt: new Date(Date.now() - 7 * 86_400_000),
            };

            // Act
            const result = target.build(
                candidate,
                [negativePreference],
                [],
                [],
                null,
            );

            // Assert
            expect(result.negativePenalty).toBeCloseTo(0.075, 2);
        });

        it('should score three dimensions with separate scales and normalized weights', () => {
            // Arrange: hai chiều đạt nửa ngưỡng và thương hiệu đạt một phần tư.
            const now = new Date('2026-11-09T00:00:00.000Z');
            const candidate = createCandidate([]);
            const product = createPreference('PRODUCT', 'product-1', 4, 0, now);
            const category = createPreference(
                'CATEGORY',
                'category-1',
                8,
                0,
                now,
            );
            const brand = createPreference('BRAND', 'brand-1', 2, 0, now);

            // Act
            const result = target.build(
                candidate,
                [product],
                [category],
                [brand],
                null,
                undefined,
                now,
            );

            // Assert: 0.5*0.5 + 0.3*0.5 + 0.2*0.25.
            expect(result.profileAffinity).toBeCloseTo(0.45);
        });

        it('should preserve positive evidence when the same preference also has negative evidence', () => {
            // Arrange: tổng signed bằng 0 nhưng mua và hoàn trả vẫn có hai vai trò riêng.
            const now = new Date('2026-11-09T00:00:00.000Z');
            const preference = createPreference(
                'PRODUCT',
                'product-1',
                8,
                8,
                now,
            );

            // Act
            const result = target.build(
                createCandidate([]),
                [preference],
                [],
                [],
                null,
                undefined,
                now,
            );

            // Assert
            expect(result.profileAffinity).toBeCloseTo(0.5);
            expect(result.negativePenalty).toBeCloseTo(0.15);
        });

        it('should halve old evidence and cap every dimension before combining', () => {
            // Arrange: 16 điểm sản phẩm đã cũ 7 ngày trở thành 8 điểm; category vượt ngưỡng.
            const now = new Date('2026-11-09T00:00:00.000Z');
            const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
            const product = createPreference(
                'PRODUCT',
                'product-1',
                16,
                0,
                weekAgo,
            );
            const category = createPreference(
                'CATEGORY',
                'category-1',
                32,
                0,
                now,
            );

            // Act
            const result = target.build(
                createCandidate([]),
                [product],
                [category],
                [],
                null,
                undefined,
                now,
            );

            // Assert: product 0.5, category 0.3, brand 0; không vượt 1.
            expect(result.profileAffinity).toBeCloseTo(0.8);
            expect(result.profileAffinity).toBeLessThanOrEqual(1);
        });
    });
});
