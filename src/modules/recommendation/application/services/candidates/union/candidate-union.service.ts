// File này hợp nhất candidate từ nhiều source theo request; không sở hữu catalog persistence hoặc ranking policy.

import { Injectable } from "@nestjs/common";
import type { RecommendationCatalogProduct } from "../../../../../catalog/application/types/catalog-product.type";
import type { CandidateContributionInput } from "../../../types/candidates/candidate-source.types";
import type { RecommendationCandidate } from "../../../types/ranking/ranking.types";

type CandidateContribution = CandidateContributionInput & { source: string };

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
    for (const [source, candidates] of bySource)
      candidates.sort((left, right) =>
        this.compareSourceCandidates(left, right, source),
      );

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

  // Khi pool vượt giới hạn, ưu tiên candidate có raw score cao trong chính source trước khi xét coverage.
  private compareSourceCandidates(
    left: RecommendationCandidate,
    right: RecommendationCandidate,
    source: string,
  ): number {
    return (
      this.sourceScore(right, source) - this.sourceScore(left, source) ||
      this.compareCandidates(left, right)
    );
  }

  // Catalog source có raw score cố định 1; semantic/relation giữ score thực để không bị cắt sai khi union.
  private sourceScore(
    candidate: RecommendationCandidate,
    source: string,
  ): number {
    const scores = (candidate.contributions ?? [])
      .filter((item) => item.source === source)
      .map((item) => (Number.isFinite(item.rawScore) ? item.rawScore : 0));
    return scores.length ? Math.max(...scores, 0) : 0;
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
