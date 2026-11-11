// Unit tests chứng minh raw score của model quyết định thứ tự và kiểm tra quota diversity.
/// <reference types="jest" />

import { ServiceUnavailableException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { createMock, type DeepMocked } from '@golevelup/ts-jest';
import { RecommendationRuleService } from '@/modules/profiles/application/services/rules/recommendation-rule.service';
import type { RecommendationCatalogProduct } from '@/modules/catalog/application/types/catalog-product.type';
import { RecommendationRankingService } from '@/modules/recommendation/application/services/ranking/policy/recommendation-ranking.service';
import type { RecommendationCandidate } from '@/modules/recommendation/application/types/ranking/ranking.types';

class MockLoggerService {
    log(): void {}
    error(): void {}
    warn(): void {}
    debug(): void {}
    verbose(): void {}
    setContext(): void {}
}

describe('RecommendationRankingService', () => {
    let target: RecommendationRankingService;
    let mockRules: DeepMocked<RecommendationRuleService>;

    // Tạo product đủ trường để test ranking không phụ thuộc persistence.
    const createProduct = (
        productId: string,
        categoryId = 'category-1',
        brandId = 'brand-1',
    ): RecommendationCatalogProduct => ({
        productId,
        name: productId,
        slug: productId,
        imageUrl: null,
        categoryId,
        brandId,
        sellerShopId: 'shop-1',
        minPrice: '100',
        maxPrice: '100',
        ratingAvg: '5',
        reviewCount: 100,
        totalSold: 10,
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
    });

    // Candidate attribution chỉ được dùng làm tie-break ổn định sau raw score.
    const createCandidate = (
        product: RecommendationCatalogProduct,
    ): RecommendationCandidate => ({
        product,
        sources: new Set(['TRENDING']),
        contributions: [],
    });

    beforeEach(async () => {
        mockRules = createMock<RecommendationRuleService>();
        mockRules.getRuleVersion.mockReturnValue('ai-ranking-test-v1');
        mockRules.getDiversityLimits.mockImplementation((surface) =>
            surface === 'product_detail'
                ? { category: 2, brand: 2, shop: 3, windowSize: 6 }
                : { category: 4, brand: 3, shop: 5, windowSize: 24 },
        );

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                RecommendationRankingService,
                { provide: RecommendationRuleService, useValue: mockRules },
            ],
        })
            .setLogger(new MockLoggerService())
            .compile();

        target = module.get<RecommendationRankingService>(
            RecommendationRankingService,
        );
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    // Model score không bị clamp thành xác suất giả, vì LambdaRank chỉ cam kết thứ tự relevance.
    it('should sort candidates by raw model score without clamping', () => {
        // Arrange
        const candidates = [
            createCandidate(createProduct('product-low')),
            createCandidate(createProduct('product-high')),
        ];

        // Act
        const result = target.rank(
            candidates,
            new Map([
                ['product-low', -2.5],
                ['product-high', 3.2],
            ]),
            new Map(),
        );

        // Assert
        expect(result.map((item) => [item.product.productId, item.score])).toEqual([
            ['product-high', 3.2],
            ['product-low', -2.5],
        ]);
        expect(target.getPolicyVersion()).toBe('ai-ranking-test-v1');
    });

    // Thiếu một prediction là lỗi dịch vụ; ranker không được tạo điểm công thức để lấp chỗ trống.
    it('should reject an incomplete model score map', () => {
        // Arrange
        const candidates = [createCandidate(createProduct('product-1'))];

        // Act / Assert
        expect(() => target.rank(candidates, new Map(), new Map())).toThrow(
            ServiceUnavailableException,
        );
    });

    // Diversity ưu tiên thứ tự score trong lượt đầu, rồi đánh dấu item chỉ được thêm khi quota nới.
    it('should preserve model order except where diversity quota requires a different category', () => {
        // Arrange
        const candidates = [
            createCandidate(createProduct('product-a-1')),
            createCandidate(createProduct('product-a-2')),
            createCandidate(createProduct('product-a-3')),
            createCandidate(
                createProduct('product-b-1', 'category-2', 'brand-2'),
            ),
        ];
        const scores = new Map([
            ['product-a-1', 4],
            ['product-a-2', 3],
            ['product-a-3', 2],
            ['product-b-1', 1],
        ]);

        // Act
        const result = target.rank(candidates, scores, new Map(), 'product_detail');

        // Assert
        expect(result.map((item) => item.product.productId)).toEqual([
            'product-a-1',
            'product-a-2',
            'product-b-1',
            'product-a-3',
        ]);
        expect(result[3]?.diversityRelaxed).toBe(true);
    });

    // Không cần gọi model hay cấu hình diversity khi candidate generation trả tập rỗng.
    it('should return an empty list for an empty candidate pool', () => {
        // Arrange / Act
        const result = target.rank([], new Map(), new Map());

        // Assert
        expect(result).toEqual([]);
        expect(mockRules.getDiversityLimits).not.toHaveBeenCalled();
    });
});
