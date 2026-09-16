// Unit test bảo vệ mode Standard/AI-Enhanced và attribution khi ML fallback.
/// <reference types="jest" />

import { Test, type TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { createMock, type DeepMocked } from "@golevelup/ts-jest";
import { RecommendationRedisService } from "../../../../../infrastructure/redis/redis.module";
import { ProfileQueryService } from "../../../../profiles/application/services/profile/profile-query.service";
import { SessionContextService } from "../../../../profiles/application/services/session/session-context.service";
import { CandidateGenerationService } from "../candidates/generation/candidate-generation.service";
import { CandidateUnionService } from "../candidates/union/candidate-union.service";
import { RankingExperimentService } from "../ranking/experiments/ranking-experiment.service";
import { RecommendationMlRankingService } from "../ranking/ml/recommendation-ml-ranking.service";
import { RecommendationRankingService } from "../ranking/policy/recommendation-ranking.service";
import { RecommendationTrackingTokenService } from "../tracking/attribution/recommendation-tracking-token.service";
import type { RecommendationCatalogProduct } from "../../../../catalog/application/types/catalog-product.type";
import type { RecommendationCandidate } from "../../types/ranking/ranking.types";
import { RecommendationQueryService } from "./recommendation-query.service";

class MockLoggerService {
  log(): void {}
  error(): void {}
  warn(): void {}
  debug(): void {}
  verbose(): void {}
  setContext(): void {}
}

describe("RecommendationQueryService", () => {
  let target: RecommendationQueryService;
  let mockProfile: DeepMocked<ProfileQueryService>;
  let mockSession: DeepMocked<SessionContextService>;
  let mockRedis: DeepMocked<RecommendationRedisService>;
  let mockRanking: DeepMocked<RecommendationRankingService>;
  let mockUnionFactory: DeepMocked<CandidateUnionService>;
  let mockCandidates: DeepMocked<CandidateGenerationService>;
  let mockExperiment: DeepMocked<RankingExperimentService>;
  let mockTrackingToken: DeepMocked<RecommendationTrackingTokenService>;
  let mockMlRanking: DeepMocked<RecommendationMlRankingService>;
  let mockUnion: { add: jest.Mock; values: jest.Mock };
  let candidate: RecommendationCandidate;

  beforeEach(async () => {
    mockProfile = createMock<ProfileQueryService>();
    mockSession = createMock<SessionContextService>();
    mockRedis = createMock<RecommendationRedisService>();
    mockRanking = createMock<RecommendationRankingService>();
    mockUnionFactory = createMock<CandidateUnionService>();
    mockCandidates = createMock<CandidateGenerationService>();
    mockExperiment = createMock<RankingExperimentService>();
    mockTrackingToken = createMock<RecommendationTrackingTokenService>();
    mockMlRanking = createMock<RecommendationMlRankingService>();

    const product: RecommendationCatalogProduct = {
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
      reviewCount: 10,
      totalSold: 5,
      status: "ACTIVE",
      isInStock: true,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
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
    };
    candidate = { product, sources: new Set(["TRENDING"]) };
    mockUnion = {
      add: jest.fn(),
      values: jest.fn().mockReturnValue([candidate]),
    };
    mockUnionFactory.create.mockReturnValue(mockUnion as never);
    mockCandidates.generate.mockResolvedValue([]);
    mockProfile.getTop.mockResolvedValue([]);
    mockRedis.getVersion.mockResolvedValue(1);
    mockRedis.getJson.mockResolvedValue(null);
    mockExperiment.resolve.mockReturnValue({
      id: "recommendation-standard-ai-v1",
      variant: "ML_HYBRID",
    });
    mockRanking.isMlRankingEnabled.mockReturnValue(true);
    mockRanking.getPolicyVersion.mockImplementation((mode) => mode);
    mockRanking.getRuleVersion.mockReturnValue("standard-ranking-v1");
    mockRanking.rank.mockReturnValue([{ ...candidate, score: 0.75 }]);
    mockMlRanking.predict.mockResolvedValue({
      scores: new Map(),
      features: new Map(),
      modelVersion: null,
    });
    mockTrackingToken.create.mockReturnValue("signed-item-token");

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecommendationQueryService,
        { provide: ConfigService, useValue: createMock<ConfigService>() },
        { provide: ProfileQueryService, useValue: mockProfile },
        { provide: SessionContextService, useValue: mockSession },
        { provide: RecommendationRedisService, useValue: mockRedis },
        { provide: RecommendationRankingService, useValue: mockRanking },
        { provide: CandidateUnionService, useValue: mockUnionFactory },
        { provide: CandidateGenerationService, useValue: mockCandidates },
        { provide: RankingExperimentService, useValue: mockExperiment },
        {
          provide: RecommendationTrackingTokenService,
          useValue: mockTrackingToken,
        },
        { provide: RecommendationMlRankingService, useValue: mockMlRanking },
      ],
    })
      .setLogger(new MockLoggerService())
      .compile();

    target = module.get<RecommendationQueryService>(RecommendationQueryService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("should fall back to Standard and omit AI attribution when model is unavailable", async () => {
    // Arrange
    const input = { surface: "home" as const, page: 1, pageSize: 24 };

    // Act
    const result = await target.getRecommendations(input, "user-1", null);

    // Assert
    expect(result).toMatchObject({
      rankingPolicyVersion: "HYBRID",
      rankingMode: "HYBRID",
      rankingModelVersion: null,
      experiment: null,
      items: [
        {
          product: { id: "product-1" },
          recommendationItemId: "signed-item-token",
        },
      ],
    });
    expect(mockRanking.rank).toHaveBeenCalledWith(
      [candidate],
      [],
      [],
      [],
      null,
      "COLD_START",
      expect.objectContaining({ mode: "HYBRID" }),
    );
    expect(mockTrackingToken.create).toHaveBeenCalledWith(
      expect.objectContaining({ experimentId: null, experimentVariant: null }),
    );
  });

  it("should not request AI when the actor is assigned Standard Ranking", async () => {
    // Arrange
    mockExperiment.resolve.mockReturnValue({ id: null, variant: "HYBRID" });
    mockRanking.isMlRankingEnabled.mockReturnValue(false);
    const input = { surface: "home" as const, page: 1, pageSize: 24 };

    // Act
    const result = await target.getRecommendations(input, "user-1", null);

    // Assert
    expect(result.experiment).toBeNull();
    expect(mockMlRanking.predict).not.toHaveBeenCalled();
    expect(mockRanking.rank).toHaveBeenCalledWith(
      [candidate],
      [],
      [],
      [],
      null,
      "COLD_START",
      expect.objectContaining({ mode: "HYBRID" }),
    );
  });
});
