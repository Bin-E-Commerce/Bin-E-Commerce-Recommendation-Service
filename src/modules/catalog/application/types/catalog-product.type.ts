// Type này là contract read model tối thiểu giữa catalog adapter và candidate/ranking, không phải Product entity.

export interface RecommendationCatalogProduct {
    productId: string;
    originType: 'INTERNAL' | 'EXTERNAL';
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
    status: 'ACTIVE' | 'INACTIVE' | 'DELETED';
    isInStock: boolean;
    createdAt: Date;
    updatedAt: Date;
    catalogVersion: string;
    shortDescription: string | null;
    description: string | null;
    brandName: string | null;
    categoryPath: string | null;
    semanticAttributes: Array<{ key: string; value: string }>;
    contentHash: string | null;
    embeddingStatus:
        | 'NOT_REQUIRED'
        | 'PENDING'
        | 'PROCESSING'
        | 'READY'
        | 'STALE'
        | 'FAILED';
    embeddingModelVersion: string | null;
    embeddingDimensions: number | null;
}

// Exclusion options dùng chung cho catalog source và hydrate để mọi tầng bảo vệ cùng một business rule.
export interface CatalogProductExclusionOptions {
    excludeProductIds?: string[];
    excludeSellerShopId?: string;
    excludeExternalShopId?: string;
}

// Query options của category/brand kế thừa exclusion chung, tránh lặp field giữa application và persistence.
export interface CatalogProductListOptions extends CatalogProductExclusionOptions {
    categoryIds?: string[];
    brandIds?: string[];
    limit?: number;
}

export interface CatalogBootstrapItem {
    id: string;
    originType?: 'INTERNAL' | 'EXTERNAL';
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
    imageUrl?: string | null;
    isInStock?: boolean;
    status?: 'ACTIVE' | 'INACTIVE' | 'DELETED';
    createdAt?: string;
    updatedAt?: string;
    description?: string | null;
    shortDescription?: string | null;
    brandName?: string | null;
    categoryPath?: string | null;
    semanticAttributes?: Array<{ key: string; value: string }>;
    contentHash?: string | null;
    catalogVersion?: string;
}
