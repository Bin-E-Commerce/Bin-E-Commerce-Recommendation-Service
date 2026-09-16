// Unit test bảo vệ các nguồn catalog dự phòng khi semantic/co-behavior không sẵn sàng.
/// <reference types="jest" />

import { Test, type TestingModule } from "@nestjs/testing";
import { createMock, type DeepMocked } from "@golevelup/ts-jest";
import { CatalogService } from "../../../../../catalog/application/services/catalog/catalog.service";
import { RelationCandidateService } from "../../../../../relations/application/services/candidates/relation-candidate.service";
import { SemanticCandidateService } from "../sources/semantic-candidate.service";
import type { RecommendationCatalogProduct } from "../../../../../catalog/application/types/catalog-product.type";
import { CandidateGenerationService } from "./candidate-generation.service";

class MockLoggerService {
  log(): void {}
  error(): void {}
  warn(): void {}
  debug(): void {}
  verbose(): void {}
  setContext(): void {}
}

describe("CandidateGenerationService", () => {
  let target: CandidateGenerationService;
  let mockCatalog: DeepMocked<CatalogService>;
  let mockSemantic: DeepMocked<SemanticCandidateService>;
  let mockRelations: DeepMocked<RelationCandidateService>;

  beforeEach(async () => {
    mockCatalog = createMock<CatalogService>();
    mockSemantic = createMock<SemanticCandidateService>();
    mockRelations = createMock<RelationCandidateService>();
    const fallbackProduct = {
      productId: "trending-fallback-product",
    } as RecommendationCatalogProduct;
    mockCatalog.findTrending.mockResolvedValue([fallbackProduct]);
    mockCatalog.findByIds.mockResolvedValue([]);
    mockSemantic.findCandidates.mockRejectedValue(
      new Error("embedding index unavailable"),
    );
    mockRelations.findCandidates.mockRejectedValue(
      new Error("relation read model unavailable"),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CandidateGenerationService,
        { provide: CatalogService, useValue: mockCatalog },
        { provide: SemanticCandidateService, useValue: mockSemantic },
        { provide: RelationCandidateService, useValue: mockRelations },
      ],
    })
      .setLogger(new MockLoggerService())
      .compile();

    target = module.get<CandidateGenerationService>(CandidateGenerationService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("should keep catalog recommendations when semantic and relation sources fail", async () => {
    // Arrange
    const input = {
      productId: "anchor-product",
      excludedProductIds: [],
      profileProductIds: [],
      categoryIds: [],
      brandIds: [],
      recentProductIds: [],
      strategy: "PERSONALIZED" as const,
    };

    // Act
    const result = await target.generate(input);

    // Assert
    expect(
      result.map((source) => ({
        source: source.source,
        productIds: source.products.map((product) => product.productId),
      })),
    ).toContainEqual({
      source: "TRENDING",
      productIds: ["trending-fallback-product"],
    });
    expect(mockCatalog.findTrending).toHaveBeenCalledWith(80, [], {});
    expect(mockSemantic.findCandidates).toHaveBeenCalledTimes(1);
    expect(mockRelations.findCandidates).toHaveBeenCalledTimes(1);
  });
});
