// Unit tests bảo vệ policy weight/decay config để thay đổi rule không âm thầm làm sai profile projection.

import { ConfigService } from "@nestjs/config";
import { RecommendationRuleService } from "./recommendation-rule.service";

describe("RecommendationRuleService", () => {
  let target: RecommendationRuleService;

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("should return configured weight and rule version", () => {
    // Arrange
    const config = {
      get: jest.fn(
        (key: string, fallback?: string) =>
          ({
            RECOMMENDATION_WEIGHT_PRODUCT_CLICKED: "3",
            RECOMMENDATION_RULE_VERSION: "phase2-rule-test",
          })[key] ?? fallback,
      ),
    } as unknown as ConfigService;
    target = new RecommendationRuleService(config);

    // Act
    const weight = target.getInteractionWeight("PRODUCT_CLICKED");
    const version = target.getRuleVersion();

    // Assert
    expect(weight).toBe(3);
    expect(version).toBe("phase2-rule-test");
  });

  it("should use safe defaults for invalid half-life configuration", () => {
    // Arrange
    const config = {
      get: jest.fn((key: string, fallback?: string) =>
        key === "RECOMMENDATION_PROFILE_HALF_LIFE_DAYS" ? "invalid" : fallback,
      ),
    } as unknown as ConfigService;
    target = new RecommendationRuleService(config);

    // Act
    const halfLifeDays = target.getProfileHalfLifeDays();

    // Assert
    expect(halfLifeDays).toBe(7);
  });

  it("should keep purchase and return weights configurable with their expected signs", () => {
    // Arrange
    const config = {
      get: jest.fn(
        (key: string, fallback?: string) =>
          ({
            RECOMMENDATION_WEIGHT_PURCHASE_COMPLETED: "10",
            RECOMMENDATION_WEIGHT_PURCHASE_RETURNED: "2",
          })[key] ?? fallback,
      ),
    } as unknown as ConfigService;
    target = new RecommendationRuleService(config);

    // Act
    const completedWeight = target.getPurchaseWeight(
      "order.purchase.completed",
    );
    const returnedWeight = target.getPurchaseWeight("order.purchase.returned");

    // Assert
    expect(completedWeight).toBe(10);
    expect(returnedWeight).toBe(-8);
  });

  it("should read hybrid weights from config and normalize their total", () => {
    // Arrange
    const config = {
      get: jest.fn((key: string, fallback?: string) =>
        key === "RECOMMENDATION_HYBRID_RANKING_WEIGHT_PROFILE_AFFINITY"
          ? "2"
          : fallback,
      ),
    } as unknown as ConfigService;
    target = new RecommendationRuleService(config);

    // Act
    const weights = target.getHybridRankingWeights();
    const total = Object.values(weights).reduce((sum, value) => sum + value, 0);

    // Assert
    expect(weights.profileAffinity).toBeCloseTo(2 / 2.75);
    expect(total).toBeCloseTo(1);
    expect(config.get).toHaveBeenCalledWith(
      "RECOMMENDATION_HYBRID_RANKING_WEIGHT_PROFILE_AFFINITY",
      "0.25",
    );
  });

  it("should combine runtime candidate policy with environment master switches", () => {
    // Arrange
    const config = {
      get: jest.fn(
        (key: string, fallback?: string) =>
          ({
            CANDIDATE_PIPELINE_V3_ENABLED: "true",
            SEMANTIC_CANDIDATES_ENABLED: "true",
            CO_BEHAVIOR_CANDIDATES_ENABLED: "false",
          })[key] ?? fallback,
      ),
    } as unknown as ConfigService;
    target = new RecommendationRuleService(config);
    target.setRuntimePolicy({
      version: "policy-v2",
      candidateSources: {
        semanticEnabled: true,
        coBehaviorEnabled: true,
      },
    });

    // Act
    const status = target.getCandidateSourceStatus();

    // Assert
    expect(status.semanticEnabled).toBe(true);
    expect(status.coBehaviorEnabled).toBe(false);
    expect(status.coBehaviorPolicyEnabled).toBe(true);
    expect(status.coBehaviorMasterEnabled).toBe(false);
  });

  it("should read experiment rollout controls from runtime policy", () => {
    // Arrange
    const config = {
      get: jest.fn((_key: string, fallback?: string) => fallback),
    } as unknown as ConfigService;
    target = new RecommendationRuleService(config);
    target.setRuntimePolicy({
      version: "policy-v3",
      experimentEnabled: true,
      trafficPercent: 35,
    });

    // Act
    const snapshot = target.getPolicySnapshot();

    // Assert
    expect(snapshot.experimentEnabled).toBe(true);
    expect(snapshot.trafficPercent).toBe(35);
  });
});
