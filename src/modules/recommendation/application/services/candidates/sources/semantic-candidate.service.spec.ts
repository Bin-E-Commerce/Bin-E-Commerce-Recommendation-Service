/// <reference types="jest" />

import { SemanticCandidateService } from "./semantic-candidate.service";

describe("SemanticCandidateService", () => {
  it("should build a weighted centroid from recent interaction signals", async () => {
    // Arrange
    const vector = {
      getProductVector: jest.fn(async (productId: string) =>
        productId === "product-a" ? [1, 0] : [0, 1],
      ),
      searchSimilarProducts: jest.fn(async () => [
        {
          productId: "product-c",
          similarityScore: 0.9,
          modelVersion: "model-v1",
        },
      ]),
    };
    const config = {
      get: jest.fn((key: string, fallback?: string) =>
        key === "CANDIDATE_PIPELINE_V3_ENABLED" ||
        key === "SEMANTIC_CANDIDATES_ENABLED"
          ? "true"
          : fallback,
      ),
    };
    const service = new SemanticCandidateService(
      vector as never,
      config as never,
    );

    // Act
    const result = await service.findCandidates({
      recentProductIds: ["product-a", "product-b"],
      recentProductSignals: [
        {
          productId: "product-a",
          weight: 4,
          interactionType: "PRODUCT_ADDED_TO_CART",
        },
        {
          productId: "product-b",
          weight: 2,
          interactionType: "PRODUCT_CLICKED",
        },
      ],
      profileProductIds: [],
      excludeProductIds: [],
      limit: 10,
    });

    // Assert
    expect(vector.searchSimilarProducts).toHaveBeenCalledWith(
      [2 / 3, 1 / 3],
      10,
      [],
    );
    expect(result[0]).toMatchObject({
      productId: "product-c",
      anchorProductId: "product-a",
    });
  });

  it("should ignore negative or zero interaction weights", async () => {
    // Arrange
    const vector = {
      getProductVector: jest.fn(async () => [1, 0]),
      searchSimilarProducts: jest.fn(async () => []),
    };
    const config = {
      get: jest.fn((key: string, fallback?: string) =>
        key === "CANDIDATE_PIPELINE_V3_ENABLED" ||
        key === "SEMANTIC_CANDIDATES_ENABLED"
          ? "true"
          : fallback,
      ),
    };
    const service = new SemanticCandidateService(
      vector as never,
      config as never,
    );

    // Act
    await service.findCandidates({
      recentProductIds: ["product-a"],
      recentProductSignals: [
        {
          productId: "product-a",
          weight: -2,
          interactionType: "PRODUCT_REMOVED_FROM_CART",
        },
      ],
      profileProductIds: [],
      excludeProductIds: [],
      limit: 10,
    });

    // Assert
    expect(vector.getProductVector).not.toHaveBeenCalled();
    expect(vector.searchSimilarProducts).not.toHaveBeenCalled();
  });
});
