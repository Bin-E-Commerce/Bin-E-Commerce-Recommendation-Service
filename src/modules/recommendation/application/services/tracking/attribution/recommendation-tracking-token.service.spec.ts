// Unit test khóa attribution token: client chỉ được ghi nhận metadata do Recommendation Service phát hành.

import { ConfigService } from "@nestjs/config";
import { RecommendationTrackingTokenService } from "./recommendation-tracking-token.service";

describe("RecommendationTrackingTokenService", () => {
  const input = {
    actorId: "user-1",
    requestId: "request-1",
    productId: "product-1",
    rank: 1,
    source: "SEMANTIC_SIMILARITY",
    surface: "home" as const,
    policyVersion: "hybrid-ranking-v1",
    experimentId: "phase4-test",
    experimentVariant: "HYBRID" as const,
  };

  function createTarget(secret = "test-secret") {
    const config = {
      get: jest.fn((key: string) =>
        key === "RECOMMENDATION_TRACKING_SECRET" ? secret : undefined,
      ),
    } as unknown as ConfigService;
    return new RecommendationTrackingTokenService(config);
  }

  it("creates a compact token that verifies for the original attribution", () => {
    // Arrange
    const target = createTarget();

    // Act
    const token = target.create(input);

    // Assert
    expect(token.length).toBeLessThan(128);
    expect(target.verify(token, input)).toBe(true);
  });

  it("rejects a token when actor or ranking attribution is changed", () => {
    // Arrange
    const target = createTarget();
    const token = target.create(input);

    // Act / Assert
    expect(target.verify(token, { ...input, actorId: "user-2" })).toBe(false);
    expect(target.verify(token, { ...input, rank: 2 })).toBe(false);
    expect(
      target.verify(token, { ...input, experimentVariant: "CONTROL" }),
    ).toBe(false);
  });

  it("requires an explicit secret in production", () => {
    // Arrange
    const config = {
      get: jest.fn((key: string) =>
        key === "NODE_ENV" ? "production" : undefined,
      ),
    } as unknown as ConfigService;

    // Act / Assert
    expect(() => new RecommendationTrackingTokenService(config)).toThrow(
      "RECOMMENDATION_TRACKING_SECRET is required in production",
    );
  });
});
