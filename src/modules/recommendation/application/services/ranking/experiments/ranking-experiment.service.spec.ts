// Unit test cho assignment A/B deterministic; cùng actor phải giữ nguyên variant giữa các request.

import { Test, type TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { createMock, type DeepMocked } from "@golevelup/ts-jest";
import { RankingExperimentService } from "./ranking-experiment.service";

class MockLoggerService {
  log(): void {}
  error(): void {}
  warn(): void {}
  debug(): void {}
  verbose(): void {}
  setContext(): void {}
}

describe("RankingExperimentService", () => {
  let target: RankingExperimentService;
  let mockConfigService: DeepMocked<ConfigService>;

  beforeEach(async () => {
    mockConfigService = createMock<ConfigService>();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RankingExperimentService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    })
      .setLogger(new MockLoggerService())
      .compile();

    target = module.get<RankingExperimentService>(RankingExperimentService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("should use Standard Ranking when the AI experiment is disabled", () => {
    // Arrange
    mockConfigService.get.mockImplementation(
      (_key: string, fallback?: unknown) => fallback as never,
    );

    // Act
    const result = target.resolve("SESSION", "session-1");

    // Assert
    expect(result).toEqual({ id: null, variant: "HYBRID" });
  });

  it("should return the same variant for the same actor", () => {
    // Arrange
    mockConfigService.get.mockImplementation(
      (key: string, fallback?: unknown) => {
        const values: Record<string, string> = {
          RANKING_EXPERIMENT_ENABLED: "true",
          RANKING_EXPERIMENT_ID: "phase4-test",
          RANKING_EXPERIMENT_TRAFFIC_PERCENT: "50",
        };
        return (values[key] ?? fallback) as never;
      },
    );

    // Act
    const first = target.resolve("USER", "user-1");
    const second = target.resolve("USER", "user-1");

    // Assert
    expect(second).toEqual(first);
    expect(first.id).toBe("phase4-test");
  });

  it("should assign every actor to AI-Enhanced when experiment traffic is one hundred percent", () => {
    // Arrange
    mockConfigService.get.mockImplementation(
      (key: string, fallback?: unknown) => {
        const values: Record<string, string> = {
          RANKING_EXPERIMENT_ENABLED: "true",
          RANKING_EXPERIMENT_ID: "phase4-test",
          RANKING_EXPERIMENT_TRAFFIC_PERCENT: "100",
        };
        return (values[key] ?? fallback) as never;
      },
    );

    // Act
    const result = target.resolve("USER", "user-100");

    // Assert
    expect(result).toEqual({ id: "phase4-test", variant: "ML_HYBRID" });
  });

  it("should assign actors only to Standard or AI-Enhanced variants", () => {
    // Arrange
    mockConfigService.get.mockImplementation(
      (key: string, fallback?: unknown) => {
        const values: Record<string, string> = {
          RANKING_EXPERIMENT_ENABLED: "true",
          RANKING_EXPERIMENT_ID: "ml-test",
          RANKING_EXPERIMENT_TRAFFIC_PERCENT: "50",
        };
        return (values[key] ?? fallback) as never;
      },
    );

    // Act
    const variants = Array.from(
      { length: 100 },
      (_, index) => target.resolve("USER", `user-${index}`).variant,
    );

    // Assert
    expect(new Set(variants)).toEqual(new Set(["HYBRID", "ML_HYBRID"]));
  });
});
