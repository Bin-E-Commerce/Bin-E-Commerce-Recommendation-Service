// File này định nghĩa application contract cho candidate, feature và kết quả ranking.
// Contract không phụ thuộc TypeORM hay HTTP để policy có thể được test độc lập.

import type { RecommendationCatalogProduct } from "../../../../catalog/application/types/catalog-product.type";

export type RankingMode = "CONTROL" | "HYBRID";

export type RecommendationCandidate = {
  product: RecommendationCatalogProduct;
  sources: Set<string>;
  contributions?: Array<{
    source: string;
    rawScore: number;
    reasonCode: string;
    anchorProductId?: string;
    modelVersion?: string;
    relationType?: "CO_VIEW" | "CO_CART" | "CO_PURCHASE";
    sourceRank?: number;
    sourceSize?: number;
  }>;
};

export interface RankingFeatureVector {
  profileAffinity: number;
  sessionContext: number;
  semanticSimilarity: number;
  coBehavior: number;
  popularity: number;
  freshness: number;
  quality: number;
  exploration: number;
  negativePenalty: number;
}

export type RankedCandidate = RecommendationCandidate & {
  score: number;
  features?: RankingFeatureVector;
  diversityRelaxed?: boolean;
};
