import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  RelationRepository,
  type RelationType,
} from "../../../infrastructure/repositories/relation.repository";

// Adapter candidate co-behavior, tách khỏi profile projection và fail-soft khi relation read model chưa có dữ liệu.
@Injectable()
export class RelationCandidateService {
  constructor(
    private readonly repository: RelationRepository,
    private readonly config: ConfigService,
  ) {}

  // Lấy target từ recent/profile anchors để bổ sung candidate cho Standard Ranking.
  async findCandidates(
    anchorProductIds: string[],
    excludeProductIds: string[],
    limit: number,
  ): Promise<
    Array<{
      productId: string;
      rawScore: number;
      anchorProductId: string;
      relationType: RelationType;
    }>
  > {
    if (
      this.config.get<string>("CANDIDATE_PIPELINE_V3_ENABLED", "false") !==
        "true" ||
      this.config.get<string>("CO_BEHAVIOR_CANDIDATES_ENABLED", "false") !==
        "true"
    )
      return [];
    try {
      const excluded = new Set(excludeProductIds);
      return (
        await this.repository.findTargets(
          [...new Set(anchorProductIds)].slice(0, 10),
          ["CO_PURCHASE", "CO_CART", "CO_VIEW"],
          Math.min(limit, 100),
        )
      ).filter((item) => !excluded.has(item.productId));
    } catch {
      return [];
    }
  }
}
