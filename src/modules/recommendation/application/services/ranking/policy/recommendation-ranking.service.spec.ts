// Unit test cho control/hybrid ranker và diversity quota; bảo vệ contract Phase 2 khi rollout Phase 4.

import { Test, type TestingModule } from "@nestjs/testing";
import { createMock, type DeepMocked } from "@golevelup/ts-jest";
import { RecommendationRuleService } from "../../../../../profiles/application/services/rules/recommendation-rule.service";
import type { RecommendationCatalogProduct } from "../../../../../catalog/application/types/catalog-product.type";
import { RankingFeatureService } from "../features/ranking-feature.service";
import { RecommendationRankingService } from "./recommendation-ranking.service";
import type { RecommendationCandidate } from "../../../types/ranking/ranking.types";

class MockLoggerService {
  log(): void {}
  error(): void {}
  warn(): void {}
  debug(): void {}
  verbose(): void {}
  setContext(): void {}
}

describe("RecommendationRankingService", () => {
  let target: RecommendationRankingService;
  let mockRules: DeepMocked<RecommendationRuleService>;
  let mockFeatures: DeepMocked<RankingFeatureService>;

  // Tạo product tối thiểu nhưng đầy đủ để ranking không phụ thuộc persistence entity.
  const createProduct = (
    productId: string,
    categoryId = "category-1",
    brandId = "brand-1",
  ): RecommendationCatalogProduct => ({
    productId,
    originType: "INTERNAL",
    name: productId,
    slug: productId,
    imageUrl: null,
    categoryId,
    brandId,
    sellerShopId: "shop-1",
    externalShopId: null,
    minPrice: "100",
    maxPrice: "100",
    ratingAvg: "5",
    reviewCount: 100,
    totalSold: 10,
    status: "ACTIVE",
    isInStock: true,
    createdAt: new Date("2099-01-01T00:00:00.000Z"),
    updatedAt: new Date("2099-01-01T00:00:00.000Z"),
    catalogVersion: "1",
    shortDescription: null,
    description: null,
    brandName: null,
    categoryPath: null,
    semanticAttributes: [],
    contentHash: null,
    embeddingStatus: "NOT_REQUIRED",
    embeddingModelVersion: null,
    embeddingDimensions: null,
  });

  // Tạo candidate theo source để test attribution và feature availability.
  const createCandidate = (
    product: RecommendationCatalogProduct,
    source: string,
    rawScore?: number,
  ): RecommendationCandidate => ({
    product,
    sources: new Set([source]),
    contributions:
      rawScore === undefined
        ? [{ source, rawScore: 1, reasonCode: source }]
        : [{ source, rawScore, reasonCode: source }],
  });

  beforeEach(async () => {
    mockRules = createMock<RecommendationRuleService>();
    mockRules.getRuleVersion.mockReturnValue("phase2-test");
    mockRules.getHybridPolicyVersion.mockReturnValue("phase4-test");
    mockRules.getProfileHalfLifeDays.mockReturnValue(7);
    mockRules.getRankingWeights.mockReturnValue({
      profileAffinity: 0.35,
      sessionContext: 0.2,
      popularity: 0.15,
      freshness: 0.1,
      quality: 0.1,
      exploration: 0.1,
    });
    mockRules.getHybridRankingWeights.mockReturnValue({
      profileAffinity: 0.25,
      sessionContext: 0.18,
      semanticSimilarity: 0.15,
      coBehavior: 0.1,
      popularity: 0.12,
      freshness: 0.08,
      quality: 0.08,
      exploration: 0.04,
    });
    mockRules.getRelationScoreScale.mockReturnValue(1);
    mockRules.getDiversityLimits.mockImplementation((surface) =>
      surface === "product_detail"
        ? { category: 2, brand: 2, shop: 3, windowSize: 6 }
        : { category: 4, brand: 3, shop: 5, windowSize: 24 },
    );
    mockFeatures = createMock<RankingFeatureService>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecommendationRankingService,
        { provide: RecommendationRuleService, useValue: mockRules },
        { provide: RankingFeatureService, useValue: mockFeatures },
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

  it("should prioritize semantic candidates in hybrid mode when their feature is stronger", () => {
    // Arrange
    const semantic = createCandidate(
      createProduct("product-semantic"),
      "SEMANTIC_SIMILARITY",
      0.9,
    );
    const explore = createCandidate(
      createProduct("product-explore"),
      "EXPLORE",
    );
    mockFeatures.build.mockImplementation((candidate) => ({
      profileAffinity: 0,
      sessionContext: 0,
      semanticSimilarity: candidate.sources.has("SEMANTIC_SIMILARITY")
        ? 0.9
        : 0,
      coBehavior: 0,
      popularity: 0,
      freshness: 0,
      quality: 0,
      exploration: candidate.sources.has("EXPLORE") ? 1 : 0,
      negativePenalty: 0,
    }));

    // Act
    const result = target.rank(
      [explore, semantic],
      [],
      [],
      [],
      null,
      "PERSONALIZED",
      { mode: "HYBRID", surface: "home" },
    );

    // Assert
    expect(result[0]?.product.productId).toBe("product-semantic");
    expect(result[0]?.features?.semanticSimilarity).toBe(0.9);
    expect(mockFeatures.build).toHaveBeenCalledTimes(2);
  });

  it("should select another category before relaxing the product-detail diversity quota", () => {
    // Arrange
    const candidates = [
      createCandidate(createProduct("product-a-1"), "CATEGORY_AFFINITY"),
      createCandidate(createProduct("product-a-2"), "CATEGORY_AFFINITY"),
      createCandidate(createProduct("product-a-3"), "CATEGORY_AFFINITY"),
      createCandidate(
        createProduct("product-b-1", "category-2", "brand-2"),
        "CATEGORY_AFFINITY",
      ),
    ];

    // Act
    const result = target.rank(candidates, [], [], [], null, "PERSONALIZED", {
      mode: "CONTROL",
      surface: "product_detail",
    });

    // Assert
    expect(result.slice(0, 3).map((item) => item.product.categoryId)).toEqual([
      "category-1",
      "category-1",
      "category-2",
    ]);
    expect(result[2]?.diversityRelaxed).toBeUndefined();
  });
});
