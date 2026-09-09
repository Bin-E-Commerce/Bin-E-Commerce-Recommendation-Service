import { Injectable } from "@nestjs/common";
import type { RecommendationCatalogProduct } from "../../../../catalog/application/types/catalog-product.type";
import type { RecommendationCandidate } from "../ranking/recommendation-ranking.service";

export interface CandidateContribution {
  source: string;
  rawScore: number;
  reasonCode: string;
  anchorProductId?: string;
  modelVersion?: string;
}

// Collector request-scoped cho candidate union; deduplicate product nhưng bảo toàn attribution của mọi source.
export class CandidateUnion {
  private readonly candidates = new Map<string, RecommendationCandidate>();

  constructor(
    private readonly excludedProductIds: ReadonlySet<string>,
    private readonly maxSize: number,
  ) {}

  // Merge toàn bộ candidate của source; giới hạn pool được áp dụng sau khi biết đủ source để không làm semantic/co-behavior bị bỏ qua.
  add(
    products: RecommendationCatalogProduct[],
    source: string,
    contributionByProductId?: Map<
      string,
      Omit<CandidateContribution, "source">
    >,
  ): void {
    for (const product of products) {
      if (this.excludedProductIds.has(product.productId)) continue;
      const detail = contributionByProductId?.get(product.productId);
      const contribution: CandidateContribution | undefined = detail
        ? { source, ...detail }
        : undefined;
      const current = this.candidates.get(product.productId);
      if (current) {
        current.sources.add(source);
        if (contribution)
          current.contributions = [
            ...(current.contributions ?? []),
            contribution,
          ];
        continue;
      }
      this.candidates.set(product.productId, {
        product,
        sources: new Set([source]),
        contributions: contribution ? [contribution] : undefined,
      });
    }
  }

  // Cắt pool theo round-robin giữa các source, sau đó ưu tiên item có nhiều attribution hơn.
  values(): RecommendationCandidate[] {
    const all = [...this.candidates.values()];
    if (all.length <= this.maxSize) return this.sortByCoverage(all);

    const bySource = new Map<string, RecommendationCandidate[]>();
    for (const candidate of all) {
      for (const source of candidate.sources) {
        const sourceCandidates = bySource.get(source) ?? [];
        sourceCandidates.push(candidate);
        bySource.set(source, sourceCandidates);
      }
    }
    for (const candidates of bySource.values())
      candidates.sort(this.compareCandidates);

    const selected = new Set<string>();
    const cursors = new Map<string, number>();
    const sources = [...bySource.keys()];
    while (selected.size < this.maxSize) {
      let added = false;
      for (const source of sources) {
        const candidates = bySource.get(source) ?? [];
        let cursor = cursors.get(source) ?? 0;
        while (
          candidates[cursor] &&
          selected.has(candidates[cursor]!.product.productId)
        )
          cursor += 1;
        cursors.set(source, cursor);
        const next = candidates[cursor];
        if (!next) continue;
        selected.add(next.product.productId);
        cursors.set(source, (cursors.get(source) ?? 0) + 1);
        added = true;
        if (selected.size >= this.maxSize) break;
      }
      if (!added) break;
    }

    return this.sortByCoverage(
      all.filter((candidate) => selected.has(candidate.product.productId)),
    );
  }

  private sortByCoverage(
    candidates: RecommendationCandidate[],
  ): RecommendationCandidate[] {
    return [...candidates].sort(this.compareCandidates);
  }

  private compareCandidates(
    left: RecommendationCandidate,
    right: RecommendationCandidate,
  ): number {
    return (
      right.sources.size - left.sources.size ||
      left.product.productId.localeCompare(right.product.productId)
    );
  }
}

// Factory stateless để mỗi request có collector riêng, tránh state leak giữa user/session.
@Injectable()
export class CandidateUnionService {
  create(excludedProductIds: string[], maxSize = 300): CandidateUnion {
    return new CandidateUnion(
      new Set(excludedProductIds),
      Math.min(Math.max(maxSize, 1), 300),
    );
  }
}
