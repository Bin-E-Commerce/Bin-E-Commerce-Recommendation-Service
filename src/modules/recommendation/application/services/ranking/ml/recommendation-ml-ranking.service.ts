// Service này là adapter application tới AI Service; chỉ gửi feature vector đã normalize, không gửi catalog text hay dữ liệu user.

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import type {
  PreferenceValue,
  SessionContext,
} from "../../../../../profiles/application/types/profile.types";
import type {
  RankingFeatureVector,
  RecommendationCandidate,
} from "../../../types/ranking/ranking.types";
import {
  RankingFeatureService,
  type RankingPreferenceLookup,
} from "../features/ranking-feature.service";
import { RecommendationRuleService } from "../../../../../profiles/application/services/rules/recommendation-rule.service";

const FEATURE_ORDER: Array<keyof RankingFeatureVector> = [
  "profileAffinity",
  "sessionContext",
  "semanticSimilarity",
  "coBehavior",
  "popularity",
  "freshness",
  "quality",
  "exploration",
  "negativePenalty",
];

export interface RecommendationMlRankingResult {
  scores: ReadonlyMap<string, number>;
  features: ReadonlyMap<string, RankingFeatureVector>;
  modelVersion: string | null;
}

export interface RecommendationMlRankingStatus {
  ready: boolean;
  fallback: boolean;
  modelVersion: string | null;
  featureCount: number | null;
  reachable: boolean;
}

@Injectable()
export class RecommendationMlRankingService {
  private readonly logger = new Logger(RecommendationMlRankingService.name);
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: ConfigService,
    private readonly features: RankingFeatureService,
    private readonly rules: RecommendationRuleService,
  ) {
    this.baseUrl = config
      .get<string>("AI_SERVICE_URL", "http://localhost:3009")
      .replace(/\/$/, "");
    this.token = config.get<string>("INTERNAL_SERVICE_TOKEN", "");
    const configuredTimeout = Number(
      config.get<string>("ML_RANKING_TIMEOUT_MS", "150"),
    );
    this.timeoutMs =
      Number.isInteger(configuredTimeout) && configuredTimeout > 0
        ? Math.min(configuredTimeout, 1000)
        : 150;
  }

  // Đọc trạng thái model qua boundary nội bộ để Admin phân biệt policy đã bật với AI thật sự đang phục vụ.
  async getStatus(): Promise<RecommendationMlRankingStatus> {
    if (!this.token) {
      return {
        ready: false,
        fallback: true,
        modelVersion: null,
        featureCount: null,
        reachable: false,
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/ranking/status`, {
        headers: { "x-internal-service-token": this.token },
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error(`AI_RANKING_STATUS_HTTP_${response.status}`);
      const payload = (await response.json()) as {
        ready?: unknown;
        fallback?: unknown;
        modelVersion?: unknown;
        featureCount?: unknown;
      };
      return {
        ready: payload.ready === true,
        fallback: payload.fallback === true,
        modelVersion:
          typeof payload.modelVersion === "string"
            ? payload.modelVersion
            : null,
        featureCount:
          typeof payload.featureCount === "number"
            ? payload.featureCount
            : null,
        reachable: true,
      };
    } catch (error) {
      this.logger.warn(
        `ML ranking status unavailable: ${this.errorMessage(error)}`,
      );
      return {
        ready: false,
        fallback: true,
        modelVersion: null,
        featureCount: null,
        reachable: false,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // Gọi batch prediction fail-soft để recommendation vẫn trả Hybrid score khi AI Service timeout, lỗi schema hoặc chưa có model.
  async predict(input: {
    requestId: string;
    candidates: RecommendationCandidate[];
    products: PreferenceValue[];
    categories: PreferenceValue[];
    brands: PreferenceValue[];
    context: SessionContext | null;
  }): Promise<RecommendationMlRankingResult> {
    if (
      !this.rules.isMlRankingEnabled() ||
      input.candidates.length === 0 ||
      !this.token
    ) {
      return { scores: new Map(), features: new Map(), modelVersion: null };
    }

    const candidates = input.candidates.slice(0, 300);
    const featureByProductId = new Map<string, RankingFeatureVector>();
    const preferenceLookup = this.features.createPreferenceLookup(
      input.products,
      input.categories,
      input.brands,
    );
    const items = candidates.map((candidate) => ({
      itemId: candidate.product.productId,
      features: this.toFeatureRow(
        this.buildFeatures(
          candidate,
          input,
          featureByProductId,
          preferenceLookup,
        ),
      ),
    }));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/ranking/predict`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-service-token": this.token,
        },
        body: JSON.stringify({
          requestId: input.requestId || randomUUID(),
          items,
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`AI_RANKING_HTTP_${response.status}`);
      const payload = (await response.json()) as {
        modelVersion?: unknown;
        predictions?: unknown;
      };
      if (!Array.isArray(payload.predictions))
        throw new Error("AI_RANKING_INVALID_RESPONSE");
      const allowed = new Set(
        candidates.map((candidate) => candidate.product.productId),
      );
      const scores = new Map<string, number>();
      for (const prediction of payload.predictions) {
        if (!this.isPrediction(prediction)) continue;
        const itemId = prediction.itemId.trim();
        if (!allowed.has(itemId)) continue;
        // Duplicate item trong response thường là lỗi contract; fail-soft để Hybrid xử lý nhất quán.
        if (scores.has(itemId)) throw new Error("AI_RANKING_DUPLICATE_ITEM");
        scores.set(itemId, this.clamp(prediction.score));
      }
      // Prediction phải đủ cho toàn bộ batch; response thiếu item hoặc chứa item lạ là invalid và phải fallback toàn batch.
      if (scores.size !== candidates.length) {
        throw new Error("AI_RANKING_INCOMPLETE_RESPONSE");
      }
      const modelVersion =
        typeof payload.modelVersion === "string" &&
        payload.modelVersion.trim().length > 0
          ? payload.modelVersion.trim()
          : null;
      // AI Service có thể trả deterministic fallback khi chưa load LightGBM;
      // fallback này không được tính là AI ranking hoặc blend vào ranking thật.
      if (modelVersion?.startsWith("ranking-fallback")) {
        return {
          scores: new Map(),
          features: featureByProductId,
          modelVersion: null,
        };
      }
      return {
        scores,
        features: featureByProductId,
        modelVersion: scores.size > 0 ? modelVersion : null,
      };
    } catch (error) {
      this.logger.warn(
        `ML ranking unavailable; using deterministic Hybrid fallback: ${this.errorMessage(error)}`,
      );
      return {
        scores: new Map(),
        features: featureByProductId,
        modelVersion: null,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // Giữ thứ tự feature cố định giữa Recommendation và AI để model artifact không bị lệch cột khi refactor code.
  private toFeatureRow(features: RankingFeatureVector): number[] {
    return FEATURE_ORDER.map((key) => this.clamp(features[key]));
  }

  // Cache feature vector trong cùng request để ranker không phải tính lại toàn bộ preference/semantic relation.
  private buildFeatures(
    candidate: RecommendationCandidate,
    input: {
      products: PreferenceValue[];
      categories: PreferenceValue[];
      brands: PreferenceValue[];
      context: SessionContext | null;
    },
    target: Map<string, RankingFeatureVector>,
    lookup: RankingPreferenceLookup,
  ): RankingFeatureVector {
    const features = this.features.build(
      candidate,
      input.products,
      input.categories,
      input.brands,
      input.context,
      lookup,
    );
    target.set(candidate.product.productId, features);
    return features;
  }

  // Chỉ nhận prediction hữu hạn trong [0, 1], không tin payload từ service nội bộ một cách mù quáng.
  private isPrediction(
    value: unknown,
  ): value is { itemId: string; score: number } {
    if (!value || typeof value !== "object") return false;
    const item = value as { itemId?: unknown; score?: unknown };
    return (
      typeof item.itemId === "string" &&
      item.itemId.trim().length > 0 &&
      typeof item.score === "number" &&
      Number.isFinite(item.score)
    );
  }

  // Clamp một lần ở boundary để model output bất thường không phá invariant ranking.
  private clamp(value: number): number {
    return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "unknown error";
  }
}
