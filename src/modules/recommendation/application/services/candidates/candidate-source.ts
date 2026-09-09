import type { RecommendationCatalogProduct } from "../../../../catalog/application/types/catalog-product.type";

export interface CandidateSourceInput {
  productId?: string;
  excludedProductIds: string[];
  profileProductIds: string[];
  categoryIds: string[];
  brandIds: string[];
  recentProductIds: string[];
}

export interface CandidateContributionInput {
  rawScore: number;
  reasonCode: string;
  anchorProductId?: string;
  modelVersion?: string;
}

export interface CandidateSourceResult {
  source: string;
  products: RecommendationCatalogProduct[];
  contributionByProductId?: Map<string, CandidateContributionInput>;
}
