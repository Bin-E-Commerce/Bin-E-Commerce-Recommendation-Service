import { Injectable } from "@nestjs/common";
import {
  RelationRepository,
  type RelationType,
} from "../../../infrastructure/repositories/relation.repository";
import { RecommendationRuleService } from "../../../../profiles/application/services/rules/recommendation-rule.service";

// Adapter candidate co-behavior, tách khỏi profile projection và fail-soft khi relation read model chưa có dữ liệu.
@Injectable()
export class RelationCandidateService {
  constructor(
    private readonly repository: RelationRepository,
    private readonly rules: RecommendationRuleService,
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
    if (!this.rules.isCandidateSourceEnabled("coBehavior")) return [];
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
