import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { VectorIndexService } from "../../../../catalog/application/services/vector/vector-index.service";

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
      const anchors = [
        ...new Set(
          [
            input.productId,
            ...input.recentProductIds.slice(0, 5),
            ...input.profileProductIds.slice(0, 5),
          ].filter(Boolean) as string[],
        ),
      ];
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
      const centroid = vectors.reduce(
        (sum, item) =>
          item.vector.map(
            (value, index) => sum[index]! + value / vectors.length,
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
        anchorProductId: vectors[0]?.id,
        modelVersion: result.modelVersion,
      }));
    } catch {
      return [];
    }
  }
}
