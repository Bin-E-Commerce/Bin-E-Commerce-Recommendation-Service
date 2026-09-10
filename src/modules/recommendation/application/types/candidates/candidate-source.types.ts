// File này định nghĩa contract giữa candidate sources và union; chỉ chứa application types, không phụ thuộc HTTP hay persistence.

import type { RecommendationCatalogProduct } from "../../../../catalog/application/types/catalog-product.type";
import type { RecommendationStrategy } from "../recommendation.types";

export interface CandidateSourceInput {
  productId?: string;
  excludedProductIds: string[];
  profileProductIds: string[];
  categoryIds: string[];
  brandIds: string[];
  recentProductIds: string[];
  recentProductSignals?: Array<{
    productId: string;
    weight: number;
    interactionType: string;
  }>;
  strategy?: RecommendationStrategy;
}

export interface CandidateContributionInput {
  rawScore: number;
  reasonCode: string;
  anchorProductId?: string;
  modelVersion?: string;
  relationType?: "CO_VIEW" | "CO_CART" | "CO_PURCHASE";
  sourceRank?: number;
  sourceSize?: number;
}

export interface CandidateSourceResult {
  source: string;
  products: RecommendationCatalogProduct[];
  contributionByProductId?: Map<
    string,
    CandidateContributionInput | CandidateContributionInput[]
  >;
}
