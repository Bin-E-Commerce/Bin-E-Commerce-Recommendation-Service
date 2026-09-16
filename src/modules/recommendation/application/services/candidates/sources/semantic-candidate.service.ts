// File này tạo semantic candidates từ vector index; không gọi AI provider trong request và không thay đổi final ranking.

import { Injectable } from "@nestjs/common";
import { CatalogService } from "../../../../../catalog/application/services/catalog/catalog.service";
import { VectorIndexService } from "../../../../../catalog/application/services/vector/vector-index.service";
import { RecommendationRuleService } from "../../../../../profiles/application/services/rules/recommendation-rule.service";

// Source semantic chỉ bổ sung candidate pool; mọi lỗi Qdrant trả [] để Standard Ranking tiếp tục với nguồn khác.
@Injectable()
export class SemanticCandidateService {
  constructor(
    private readonly vector: VectorIndexService,
    private readonly catalog: CatalogService,
    private readonly rules: RecommendationRuleService,
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
      contentHash: string;
    }>
  > {
    if (!this.rules.isCandidateSourceEnabled("semantic")) return [];
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
      const snapshots = await this.catalog.findSnapshots(anchors);
      const snapshotById = new Map(
        snapshots.map((snapshot) => [snapshot.productId, snapshot]),
      );
      const vectorResults = await Promise.allSettled(
        anchors.map(async (id) => {
          const contentHash = snapshotById.get(id)?.contentHash;
          if (!contentHash) return null;
          const result = await this.vector.getProductVector(id, contentHash);
          return result ? { id, ...result } : null;
        }),
      );
      const vectors = vectorResults
        .filter(
          (
            result,
          ): result is PromiseFulfilledResult<{
            id: string;
            vector: number[];
            contentHash: string;
            modelVersion: string;
          } | null> => result.status === "fulfilled",
        )
        .map((result) => result.value)
        .filter(
          (
            item,
          ): item is {
            id: string;
            vector: number[];
            contentHash: string;
            modelVersion: string;
          } => item !== null,
        );
      if (!vectors.length) return [];
      const length = vectors[0]!.vector.length;
      if (
        vectors.some(
          (item) =>
            item.vector.length !== length ||
            item.vector.some((value) => !Number.isFinite(value)),
        )
      )
        return [];
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
      // Tính anchor mạnh nhất một lần thay vì sort toàn bộ anchor cho từng result.
      const primaryAnchorProductId = [...anchorWeights.entries()].sort(
        (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
      )[0]?.[0];
      return results.map((result) => ({
        productId: result.productId,
        rawScore: result.similarityScore,
        anchorProductId: primaryAnchorProductId,
        modelVersion: result.modelVersion,
        contentHash: result.contentHash,
      }));
    } catch {
      return [];
    }
  }
}
