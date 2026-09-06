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
      get: jest.fn((key: string, fallback?: string) =>
        ({
          RECOMMENDATION_WEIGHT_PRODUCT_CLICKED: "3",
          RECOMMENDATION_RULE_VERSION: "phase2-rule-test",
        }[key] ?? fallback),
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
});
