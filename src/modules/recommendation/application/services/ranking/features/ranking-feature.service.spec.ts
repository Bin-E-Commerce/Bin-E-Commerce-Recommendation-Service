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

        // Cùng hai số hữu hạn cực lớn vẫn cho đúng tỷ lệ 1/2 mà không tràn mẫu số.
        it('should normalize large finite relation values without overflow', () => {
            // Arrange
            mockRules.getRelationScoreScale.mockReturnValue(Number.MAX_VALUE);
            const candidate = createCandidate([
                {
                    source: 'CO_BEHAVIOR',
                    rawScore: Number.MAX_VALUE,
                    reasonCode: 'CO_VIEW',
                    relationType: 'CO_VIEW',
                },
            ]);

            // Act
            const result = target.build(candidate, [], [], [], null);

            // Assert
            expect(result.coBehavior).toBeCloseTo(0.5);
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

        // Vị trí đầu nhận 1, vị trí thứ hai nhận 1/2 ở mỗi chiều rồi hai chiều được lấy trung bình.
        it('should rank recent category and brand matches by position', () => {
            // Arrange
            const context = {
                sessionId: 'session-1',
                recentProductIds: [],
                recentCategoryIds: ['category-1', 'category-2'],
                recentBrandIds: ['brand-2', 'brand-1'],
                currentProductId: 'anchor-1',
                currentCategoryId: null,
                latestQuery: null,
                cartProductIds: [],
                intentUpdatedAt: '2026-11-09T00:00:00.000Z',
                version: 1,
            };
            const candidate = createCandidate([
                {
                    source: 'SEMANTIC_SIMILARITY',
                    rawScore: 0.5,
                    reasonCode: 'SIMILAR',
                    anchorProductId: 'anchor-1',
                },
            ]);

            // Act
            const result = target.build(candidate, [], [], [], context);

            // Assert: category mới nhất = 1, brand cũ hơn = 1/2.
            expect(result.sessionContext).toBeCloseTo(0.75);
            expect(
                target.build(candidate, [], [], [], null).sessionContext,
            ).toBe(0);
        });

        // Candidate đến từ sản phẩm đang xem không tự chứng minh danh mục hoặc thương hiệu đang được quan tâm.
        it('should not score an anchor match without session attribute matches', () => {
            // Arrange
            const candidate = createCandidate([
                {
                    source: 'SEMANTIC_SIMILARITY',
                    rawScore: 0.8,
                    reasonCode: 'SIMILAR',
                    anchorProductId: 'anchor-1',
                },
            ]);
            const context = {
                sessionId: 'session-1',
                recentProductIds: [],
                recentCategoryIds: ['category-other'],
                recentBrandIds: ['brand-other'],
                currentProductId: 'anchor-1',
                currentCategoryId: null,
                latestQuery: null,
                cartProductIds: [],
                intentUpdatedAt: '2026-11-09T00:00:00.000Z',
                version: 1,
            };

            // Act
            const result = target.build(candidate, [], [], [], context);

            // Assert
            expect(result.sessionContext).toBe(0);
        });

        // Khi chỉ một chiều khớp, trung bình hai chiều giữ điểm tại 0.5 thay vì suy diễn chiều còn lại.
        it('should not infer a brand match from a category-only session', () => {
            // Arrange
            const context = {
                sessionId: 'session-1',
                recentProductIds: [],
                recentCategoryIds: ['category-1'],
                recentBrandIds: [],
                currentProductId: null,
                currentCategoryId: null,
                latestQuery: null,
                cartProductIds: [],
                intentUpdatedAt: '2026-11-09T00:00:00.000Z',
                version: 1,
            };

            // Act
            const result = target.build(
                createCandidate([]),
                [],
                [],
                [],
                context,
            );

            // Assert
            expect(result.sessionContext).toBe(0.5);
        });

        // Semantic feature chỉ nhận semantic contribution và giới hạn raw similarity vào [0, 1].
        it('should normalize semantic similarity and ignore unrelated sources', () => {
            const candidate = createCandidate([
                {
                    source: 'SEMANTIC_SIMILARITY',
                    rawScore: 1.4,
                    reasonCode: 'SIMILAR',
                },
                {
                    source: 'TRENDING',
                    rawScore: 0.95,
                    reasonCode: 'POPULAR',
                },
            ]);

            const result = target.build(candidate, [], [], [], null);

            expect(result.semanticSimilarity).toBe(1);
        });

        // Semantic lấy contribution cosine lớn nhất sau clamp; score âm và source khác không cộng điểm.
        it('should clamp negative semantic scores and take the strongest semantic contribution', () => {
            const candidate = createCandidate([
                {
                    source: 'SEMANTIC_SIMILARITY',
                    rawScore: -0.3,
                    reasonCode: 'SIMILAR',
                },
                {
                    source: 'SEMANTIC_SIMILARITY',
                    rawScore: 0.7,
                    reasonCode: 'SIMILAR',
                },
                {
                    source: 'TRENDING',
                    rawScore: 0.95,
                    reasonCode: 'POPULAR',
                },
            ]);

            const result = target.build(candidate, [], [], [], null);

            expect(result.semanticSimilarity).toBeCloseTo(0.7);
        });

        // Co-behavior dùng hàm tăng bão hòa, không âm và không vượt một.
        it('should keep co-behavior monotonic and bounded', () => {
            const zero = target.build(
                createCandidate([
                    {
                        source: 'CO_BEHAVIOR',
                        rawScore: 0,
                        reasonCode: 'CO_VIEW',
                        relationType: 'CO_VIEW',
                    },
                ]),
                [],
                [],
                [],
                null,
            );
            const larger = target.build(
                createCandidate([
                    {
                        source: 'CO_BEHAVIOR',
                        rawScore: 9,
                        reasonCode: 'CO_VIEW',
                        relationType: 'CO_VIEW',
                    },
                ]),
                [],
                [],
                [],
                null,
            );

            expect(zero.coBehavior).toBe(0);
            expect(larger.coBehavior).toBeGreaterThan(zero.coBehavior);
            expect(larger.coBehavior).toBeLessThan(1);
        });

        // Reducer max được áp dụng sau chuẩn hóa riêng từng relation, không theo raw score hoặc tổng.
        it('should take the maximum after normalizing mixed relation types', () => {
            const candidate = createCandidate([
                {
                    source: 'CO_BEHAVIOR',
                    rawScore: 2,
                    reasonCode: 'CO_VIEW',
                    relationType: 'CO_VIEW',
                },
                {
                    source: 'CO_BEHAVIOR',
                    rawScore: 6,
                    reasonCode: 'CO_PURCHASE',
                    relationType: 'CO_PURCHASE',
                },
            ]);

            const result = target.build(candidate, [], [], [], null);

            expect(result.coBehavior).toBeCloseTo(2 / 3);
        });

        // Score âm hoặc không hữu hạn không phải bằng chứng quan hệ dương và phải đóng góp 0.
        it.each([
            -1,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            Number.NEGATIVE_INFINITY,
        ])('should map invalid co-behavior scores %s to zero', (rawScore) => {
            const candidate = createCandidate([
                {
                    source: 'CO_BEHAVIOR',
                    rawScore,
                    reasonCode: 'CO_VIEW',
                    relationType: 'CO_VIEW',
                },
            ]);

            const result = target.build(candidate, [], [], [], null);

            expect(result.coBehavior).toBe(0);
        });

        // Popularity lấy tín hiệu lớn hơn giữa doanh số log-scale và vị trí source hợp lệ.
        it('should normalize popularity and ignore source rank without its list size', () => {
            const ranked = target.build(
                createCandidate([
                    {
                        source: 'TRENDING',
                        rawScore: 0,
                        reasonCode: 'TRENDING',
                        sourceRank: 2,
                        sourceSize: 5,
                    },
                ]),
                [],
                [],
                [],
                null,
            );
            const missingListSize = target.build(
                createCandidate([
                    {
                        source: 'TRENDING',
                        rawScore: 0,
                        reasonCode: 'TRENDING',
                        sourceRank: 1,
                    },
                ]),
                [],
                [],
                [],
                null,
            );

            expect(ranked.popularity).toBeCloseTo(0.75);
            expect(missingListSize.popularity).toBeCloseTo(Math.log1p(10) / 12);
        });

        // Sales không hữu hạn được thay riêng bằng 0 để giữ thứ hạng nguồn đáng tin cậy.
        it.each([
            Number.NaN,
            Number.POSITIVE_INFINITY,
            Number.NEGATIVE_INFINITY,
        ])(
            'should preserve a valid popularity source rank when totalSold is %s',
            (totalSold) => {
                // Arrange
                const candidate = createCandidate([
                    {
                        source: 'TRENDING',
                        rawScore: 0,
                        reasonCode: 'TRENDING',
                        sourceRank: 2,
                        sourceSize: 5,
                    },
                ]);
                candidate.product.totalSold = totalSold;

                // Act
                const result = target.build(candidate, [], [], [], null);

                // Assert
                expect(result.popularity).toBeCloseTo(0.75);
            },
        );

        // Freshness không tăng khi tuổi sản phẩm lớn hơn; các mốc bucket cố định phải khớp code.
        it('should assign freshness by the documented age buckets', () => {
            const now = new Date('2026-11-09T00:00:00.000Z');
            const freshCandidate = createCandidate([]);
            freshCandidate.product.createdAt = new Date(
                now.getTime() - 1 * 86_400_000,
            );
            const oldCandidate = createCandidate([]);
            oldCandidate.product.createdAt = new Date(
                now.getTime() - 31 * 86_400_000,
            );

            const fresh = target.build(
                freshCandidate,
                [],
                [],
                [],
                null,
                undefined,
                now,
            );
            const old = target.build(
                oldCandidate,
                [],
                [],
                [],
                null,
                undefined,
                now,
            );

            expect(fresh.freshness).toBe(1);
            expect(old.freshness).toBe(0.3);
            expect(fresh.freshness).toBeGreaterThan(old.freshness);
        });

        // Kiểm tra ngay tại và sau mọi ngưỡng để bắt sai lệch điều kiện <= của bucket.
        it.each([
            [0, 1],
            [1, 1],
            [1.0001, 0.8],
            [7, 0.8],
            [7.0001, 0.55],
            [30, 0.55],
            [30.0001, 0.3],
            [90, 0.3],
            [90.0001, 0.1],
            [-1, 1],
        ])(
            'should preserve freshness bucket at age %s days',
            (ageDays, expected) => {
                const now = new Date('2026-11-09T00:00:00.000Z');
                const candidate = createCandidate([]);
                candidate.product.createdAt = new Date(
                    now.getTime() - ageDays * 86_400_000,
                );

                const result = target.build(
                    candidate,
                    [],
                    [],
                    [],
                    null,
                    undefined,
                    now,
                );

                expect(result.freshness).toBeCloseTo(expected, 4);
            },
        );

        // Quality gồm ba đầu vào chuẩn hóa; sản phẩm đạt cực đại chỉ khi từng thành phần đạt cực đại.
        it('should combine normalized rating, log-scaled review count, and availability', () => {
            const candidate = createCandidate([]);

            const result = target.build(candidate, [], [], [], null);

            expect(result.quality).toBe(1);
        });

        // Golden case đối chiếu trực tiếp ba thành phần với công thức quality đã ghi trong tài liệu.
        it('should match the documented quality formula for a partial rating and review count', () => {
            const candidate = createCandidate([]);
            candidate.product.ratingAvg = '4.5';
            candidate.product.reviewCount = 25;

            const result = target.build(candidate, [], [], [], null);
            const expected =
                0.55 * 0.9 + (0.25 * Math.log1p(25)) / Math.log1p(100) + 0.2;

            expect(result.quality).toBeCloseTo(expected, 8);
        });

        // Count review lỗi chỉ được quy về 0; rating và stock hợp lệ tiếp tục đóng góp điểm.
        it.each([
            Number.NaN,
            Number.POSITIVE_INFINITY,
            Number.NEGATIVE_INFINITY,
        ])(
            'should preserve valid quality signals when review count is %s',
            (reviewCount) => {
                const candidate = createCandidate([]);
                candidate.product.reviewCount = reviewCount;

                const result = target.build(candidate, [], [], [], null);

                expect(result.quality).toBeCloseTo(0.75);
            },
        );

        // Exploration là cờ nhị phân có điều kiện, không khuyến khích candidate khi profile đã mạnh.
        it('should enable exploration only for weak profile affinity', () => {
            const candidate = createCandidate([]);
            candidate.sources.add('EXPLORE');
            const strongPreference = createPreference(
                'PRODUCT',
                'product-1',
                8,
                0,
                new Date('2026-11-09T00:00:00.000Z'),
            );
            const referenceTime = new Date('2026-11-09T00:00:00.000Z');

            expect(target.build(candidate, [], [], [], null).exploration).toBe(
                1,
            );
            expect(
                target.build(
                    candidate,
                    [strongPreference],
                    [],
                    [],
                    null,
                    undefined,
                    referenceTime,
                ).exploration,
            ).toBe(0);
        });

        // Ngưỡng dùng điều kiện profileAffinity > 0.4; tại đúng 0.4 nguồn EXPLORE vẫn được bật.
        it('should allow exploration when profile affinity is exactly at the threshold', () => {
            const candidate = createCandidate([]);
            candidate.sources.add('EXPLORE');
            const preference = createPreference(
                'PRODUCT',
                'product-1',
                6.4,
                0,
                new Date('2026-11-09T00:00:00.000Z'),
            );
            const referenceTime = new Date('2026-11-09T00:00:00.000Z');

            const result = target.build(
                candidate,
                [preference],
                [],
                [],
                null,
                undefined,
                referenceTime,
            );

            expect(result.profileAffinity).toBeCloseTo(0.4);
            expect(result.exploration).toBe(1);
        });

        // Từng feature tạo cho LambdaRank phải là số hữu hạn trong miền huấn luyện [0, 1].
        it('should keep all model input features finite and bounded', () => {
            const result = target.build(
                createCandidate([
                    {
                        source: 'SEMANTIC_SIMILARITY',
                        rawScore: Number.POSITIVE_INFINITY,
                        reasonCode: 'SIMILAR',
                    },
                ]),
                [],
                [],
                [],
                null,
            );

            expect(Object.values(result).every(Number.isFinite)).toBe(true);
            expect(
                Object.values(result).every(
                    (value) => value >= 0 && value <= 1,
                ),
            ).toBe(true);
        });
    });
});
