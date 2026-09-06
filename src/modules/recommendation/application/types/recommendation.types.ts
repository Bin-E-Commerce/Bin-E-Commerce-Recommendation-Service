// Contract application này tách response recommendation khỏi TypeORM entity và Product API response.

export type RecommendationSurface =
  | "home"
  | "product_detail"
  | "recommendations_page";
export type RecommendationStrategy =
  | "PERSONALIZED"
  | "SESSION_BASED"
  | "COLD_START";

export interface RecommendationProductResponse {
  id: string;
  originType: "INTERNAL" | "EXTERNAL";
  name: string;
  slug: string;
  sellerShopId: string | null;
  categoryId: string | null;
  minPrice: string;
  maxPrice: string;
  displayPrice: string;
  displayOriginalPrice: null;
  totalSold: number;
  ratingAvg: string | null;
  reviewCount: number;
  images: Array<{
    id: string;
    imageUrl: string;
    sortOrder: number;
    isThumbnail: boolean;
  }>;
  externalShop: null;
  brand: null;
}

export interface RecommendationItemResponse {
  product: RecommendationProductResponse;
  rank: number;
  score: number;
  source: string;
  reasons: string[];
}

export interface RecommendationResponse {
  requestId: string;
  strategy: RecommendationStrategy;
  profileState: "USER" | "GUEST" | "NEW_USER";
  items: RecommendationItemResponse[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  generatedAt: string;
  ruleVersion: string;
}
