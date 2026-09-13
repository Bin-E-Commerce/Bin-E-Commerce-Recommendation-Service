// Unit test bảo vệ fail-soft của AI adapter khi model lỗi hoặc chỉ là fallback placeholder.

import { Test, type TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { createMock, type DeepMocked } from "@golevelup/ts-jest";
import { RecommendationRuleService } from "../../../../../profiles/application/services/rules/recommendation-rule.service";
import { RankingFeatureService } from "../features/ranking-feature.service";
import type { RecommendationCandidate } from "../../../types/ranking/ranking.types";
import { RecommendationMlRankingService } from "./recommendation-ml-ranking.service";

class MockLoggerService {
  log(): void {}
  error(): void {}
  warn(): void {}
  debug(): void {}
  verbose(): void {}
  setContext(): void {}
}

describe("RecommendationMlRankingService", () => {
  let target: RecommendationMlRankingService;
  let mockConfig: DeepMocked<ConfigService>;
  let mockFeatures: DeepMocked<RankingFeatureService>;
  let mockRules: DeepMocked<RecommendationRuleService>;

  const featureVector = {
    profileAffinity: 0.2,
    sessionContext: 0.1,
    semanticSimilarity: 0.3,
    coBehavior: 0.1,
    popularity: 0.1,
    freshness: 0.1,
    quality: 0.1,
    exploration: 0,
    negativePenalty: 0,
  };

  beforeEach(async () => {
    mockConfig = createMock<ConfigService>();
    mockFeatures = createMock<RankingFeatureService>();
    mockRules = createMock<RecommendationRuleService>();
    mockConfig.get.mockImplementation((key: string, fallback?: unknown) => {
      const values: Record<string, string> = {
        AI_SERVICE_URL: "http://ai.test",
        INTERNAL_SERVICE_TOKEN: "test-token",
        ML_RANKING_TIMEOUT_MS: "150",
      };
      return (values[key] ?? fallback) as never;
    });
    mockRules.isMlRankingEnabled.mockReturnValue(true);
    mockFeatures.createPreferenceLookup.mockReturnValue({
      product: new Map(),
      category: new Map(),
      brand: new Map(),
    });
    mockFeatures.build.mockReturnValue(featureVector);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecommendationMlRankingService,
        { provide: ConfigService, useValue: mockConfig },
        { provide: RankingFeatureService, useValue: mockFeatures },
        { provide: RecommendationRuleService, useValue: mockRules },
      ],
    })
      .setLogger(new MockLoggerService())
      .compile();

    target = module.get<RecommendationMlRankingService>(
      RecommendationMlRankingService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it("should return no ML score when the AI service request fails", async () => {
    // Arrange
    const mockFetch = jest
      .spyOn(global, "fetch")
      .mockRejectedValue(new Error("AI service unavailable"));
    const candidate = {
      product: { productId: "product-1" },
      sources: new Set(["TRENDING"]),
    } as RecommendationCandidate;

    // Act
    const result = await target.predict({
      requestId: "request-1",
      candidates: [candidate],
      products: [],
      categories: [],
      brands: [],
      context: null,
    });

    // Assert
    expect(result).toEqual({
      scores: new Map(),
      features: new Map([["product-1", featureVector]]),
      modelVersion: null,
    });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://ai.test/api/v1/ranking/predict",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("should reject the placeholder AI model as an active prediction", async () => {
    // Arrange
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        modelVersion: "ranking-fallback-v1",
        predictions: [{ itemId: "product-1", score: 0.95 }],
      }),
    } as Response);
    const candidate = {
      product: { productId: "product-1" },
      sources: new Set(["TRENDING"]),
    } as RecommendationCandidate;

    // Act
    const result = await target.predict({
      requestId: "request-1",
      candidates: [candidate],
      products: [],
      categories: [],
      brands: [],
      context: null,
    });

    // Assert
    expect(result.scores).toEqual(new Map());
    expect(result.modelVersion).toBeNull();
  });
});
