// Type này là contract read model tối thiểu giữa catalog adapter và candidate/ranking, không phải Product entity.

export interface RecommendationCatalogProduct {
  productId: string;
  originType: "INTERNAL" | "EXTERNAL";
  name: string;
  slug: string;
  imageUrl: string | null;
  categoryId: string | null;
  brandId: string | null;
  sellerShopId: string | null;
  externalShopId: string | null;
  minPrice: string;
  maxPrice: string;
  ratingAvg: string | null;
  reviewCount: number;
  totalSold: number;
  status: "ACTIVE" | "INACTIVE" | "DELETED";
  isInStock: boolean;
  createdAt: Date;
  updatedAt: Date;
  catalogVersion: number;
}

// Query options dùng chung giữa candidate application service và catalog persistence adapter.
export interface CatalogProductListOptions {
  categoryIds?: string[];
  brandIds?: string[];
  excludeProductIds?: string[];
  limit?: number;
}

export interface CatalogBootstrapItem {
  id: string;
  originType?: "INTERNAL" | "EXTERNAL";
  name: string;
  slug: string;
  minPrice: string;
  maxPrice: string;
  displayPrice?: string;
  ratingAvg?: string | null;
  reviewCount?: number;
  totalSold?: number;
  categoryId?: string | null;
  sellerShopId?: string | null;
  externalShop?: { id: string } | null;
  brand?: { id: string } | null;
  images?: Array<{ imageUrl: string; sortOrder?: number }>;
}
