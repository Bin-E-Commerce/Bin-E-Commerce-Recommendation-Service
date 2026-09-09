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

  it("should keep anonymous assignment in control when experiment is disabled", () => {
    // Arrange
    mockConfigService.get.mockImplementation(
      (_key: string, fallback?: unknown) => fallback as never,
    );

    // Act
    const result = target.resolve("SESSION", "session-1");

    // Assert
    expect(result).toEqual({ id: null, variant: "CONTROL" });
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

  it("should assign every actor to hybrid when traffic is one hundred percent", () => {
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
    expect(result).toEqual({ id: "phase4-test", variant: "HYBRID" });
  });
});
