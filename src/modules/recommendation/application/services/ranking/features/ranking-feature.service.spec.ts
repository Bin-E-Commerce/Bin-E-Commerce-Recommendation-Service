// Unit test cho feature vector Phase 4; bảo vệ việc tách semantic/co-behavior khỏi tín hiệu catalog thông thường.

import { Test, type TestingModule } from "@nestjs/testing";
import { createMock, type DeepMocked } from "@golevelup/ts-jest";
import { RecommendationRuleService } from "../../../../../profiles/application/services/rules/recommendation-rule.service";
import type { PreferenceValue } from "../../../../../profiles/application/types/profile.types";
import type { RecommendationCatalogProduct } from "../../../../../catalog/application/types/catalog-product.type";
import { RankingFeatureService } from "./ranking-feature.service";
import type { RecommendationCandidate } from "../../../types/ranking/ranking.types";

class MockLoggerService {
  log(): void {}
  error(): void {}
  warn(): void {}
  debug(): void {}
  verbose(): void {}
  setContext(): void {}
}

describe("RankingFeatureService", () => {
  let target: RankingFeatureService;
  let mockRules: DeepMocked<RecommendationRuleService>;

  // Tạo catalog fixture đầy đủ để test chỉ tập trung vào feature cần kiểm tra.
  const createProduct = (): RecommendationCatalogProduct => ({
    productId: "product-1",
    originType: "INTERNAL",
    name: "Product 1",
    slug: "product-1",
    imageUrl: null,
    categoryId: "category-1",
    brandId: "brand-1",
    sellerShopId: "shop-1",
    externalShopId: null,
    minPrice: "100",
    maxPrice: "100",
    ratingAvg: "5",
    reviewCount: 100,
    totalSold: 10,
    status: "ACTIVE",
    isInStock: true,
    createdAt: new Date(),
    updatedAt: new Date(),
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

  // Tạo candidate có attribution tùy biến để kiểm tra normalization theo đúng source.
  const createCandidate = (
    contributions: NonNullable<RecommendationCandidate["contributions"]>,
  ): RecommendationCandidate => ({
    product: createProduct(),
    sources: new Set(contributions.map((item) => item.source)),
    contributions,
  });

  beforeEach(async () => {
    mockRules = createMock<RecommendationRuleService>();
    mockRules.getProfileHalfLifeDays.mockReturnValue(7);
    mockRules.getRelationScoreScale.mockImplementation((relationType) =>
      relationType === "CO_PURCHASE" ? 6 : 1,
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

  describe("build", () => {
    it("should ignore non co-behavior contributions when calculating co-behavior", () => {
      // Arrange
      const candidate = createCandidate([
        {
          source: "CATEGORY_AFFINITY",
          rawScore: 100,
          reasonCode: "MATCHED_CATEGORY",
          relationType: "CO_PURCHASE",
        },
      ]);

      // Act
      const result = target.build(candidate, [], [], [], null);

      // Assert
      expect(result.coBehavior).toBe(0);
      expect(mockRules.getRelationScoreScale).not.toHaveBeenCalled();
    });

    it("should normalize co-purchase relation with its configured scale", () => {
      // Arrange
      const candidate = createCandidate([
        {
          source: "CO_BEHAVIOR",
          rawScore: 6,
          reasonCode: "CO_PURCHASE",
          relationType: "CO_PURCHASE",
        },
      ]);

      // Act
      const result = target.build(candidate, [], [], [], null);

      // Assert
      expect(result.coBehavior).toBeCloseTo(0.5);
      expect(mockRules.getRelationScoreScale).toHaveBeenCalledWith(
        "CO_PURCHASE",
      );
      expect(mockRules.getRelationScoreScale).toHaveBeenCalledTimes(1);
    });

    it("should decay a negative preference before applying the penalty", () => {
      // Arrange
      const candidate = createCandidate([]);
      const negativePreference: PreferenceValue = {
        actorType: "USER",
        actorId: "user-1",
        dimension: "PRODUCT",
        dimensionKey: "product-1",
        score: -8,
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
  });
});
