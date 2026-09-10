// File này tạo semantic candidates từ vector index; không gọi AI provider trong request và không thay đổi final ranking.

import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { VectorIndexService } from "../../../../../catalog/application/services/vector/vector-index.service";

// Source semantic chỉ bổ sung candidate pool; mọi lỗi Qdrant trả [] để Phase 2 ranking/fallback tiếp tục hoạt động.
@Injectable()
export class SemanticCandidateService {
  constructor(
    private readonly vector: VectorIndexService,
    private readonly config: ConfigService,
  ) {}

  // Tạo centroid ngắn hạn từ anchor product gần đây rồi hydrate card bằng catalog read model cục bộ.
  async findCandidates(input: {
    productId?: string;
    recentProductIds: string[];
    recentProductSignals?: Array<{
      productId: string;
      weight: number;
      interactionType: string;
    }>;
    profileProductIds: string[];
    excludeProductIds: string[];
    limit: number;
  }): Promise<
    Array<{
      productId: string;
      rawScore: number;
      anchorProductId?: string;
      modelVersion: string;
    }>
  > {
    if (
      this.config.get<string>("CANDIDATE_PIPELINE_V3_ENABLED", "false") !==
        "true" ||
      this.config.get<string>("SEMANTIC_CANDIDATES_ENABLED", "false") !== "true"
    )
      return [];
    try {
      const anchorWeights = new Map<string, number>();
      const addAnchor = (id: string | undefined, weight: number): void => {
        if (!id || !Number.isFinite(weight) || weight <= 0) return;
        anchorWeights.set(id, (anchorWeights.get(id) ?? 0) + weight);
      };
      addAnchor(input.productId, 1);
      const signals = new Map(
        (input.recentProductSignals ?? []).map((signal) => [
          signal.productId,
          signal,
        ]),
      );
      for (const productId of input.recentProductIds.slice(0, 5)) {
        addAnchor(productId, signals.get(productId)?.weight ?? 1);
      }
      for (const productId of input.profileProductIds.slice(0, 5))
        addAnchor(productId, 0.5);
      const anchors = [...anchorWeights.keys()];
      const vectors = (
        await Promise.all(
          anchors.map(async (id) => ({
            id,
            vector: await this.vector.getProductVector(id),
          })),
        )
      ).filter((item): item is { id: string; vector: number[] } =>
        Array.isArray(item.vector),
      );
      if (!vectors.length) return [];
      const length = vectors[0]!.vector.length;
      const totalWeight = vectors.reduce(
        (sum, item) => sum + (anchorWeights.get(item.id) ?? 0),
        0,
      );
      if (totalWeight <= 0) return [];
      const centroid = vectors.reduce(
        (sum, item) =>
          item.vector.map(
            (value, index) =>
              sum[index]! +
              (value * (anchorWeights.get(item.id) ?? 0)) / totalWeight,
          ),
        new Array<number>(length).fill(0),
      );
      const results = await this.vector.searchSimilarProducts(
        centroid,
        Math.min(input.limit, 60),
        input.excludeProductIds,
      );
      return results.map((result) => ({
        productId: result.productId,
        rawScore: result.similarityScore,
        anchorProductId: [...anchorWeights.entries()].sort(
          (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
        )[0]?.[0],
        modelVersion: result.modelVersion,
      }));
    } catch {
      return [];
    }
  }
}
