// Contract của dataset synthetic offline; file này không được dùng trong HTTP request path hoặc ghi dữ liệu nghiệp vụ.

import type { RecommendationCatalogProduct } from '@/modules/catalog/application/types/catalog-product.type';

export const SYNTHETIC_FEATURE_ORDER = [
    'profileAffinity',
    'sessionContext',
    'semanticSimilarity',
    'coBehavior',
    'popularity',
    'freshness',
    'quality',
    'exploration',
    'negativePenalty',
] as const;

export type SyntheticInteractionType =
    | 'PRODUCT_IMPRESSED'
    | 'PRODUCT_VIEWED'
    | 'PRODUCT_CLICKED'
    | 'PRODUCT_ADDED_TO_CART'
    | 'PRODUCT_REMOVED_FROM_CART'
    | 'PURCHASE_COMPLETED';

export type SyntheticDatasetSplit = 'train' | 'validation' | 'test';

export interface RankingSyntheticOptions {
    users: number;
    sessions: number;
    targetEvents: number;
    seed: number;
    referenceTime: Date;
}

export interface RankingSyntheticPersona {
    userId: string;
    categoryIds: string[];
    brandIds: string[];
    minPrice: number;
    maxPrice: number;
    riskTolerance: number;
}

export interface RankingSyntheticSession {
    userId: string;
    sessionId: string;
    requestId: string;
    surface: 'home' | 'product_detail' | 'recommendations_page';
    currentProductId: string | null;
    recentProductIds: string[];
    recentCategoryIds: string[];
    recentBrandIds: string[];
    createdAt: string;
    split: SyntheticDatasetSplit;
}

export interface RankingSyntheticEvent {
    eventId: string;
    userId: string;
    sessionId: string;
    requestId: string;
    itemId: string;
    interactionType: SyntheticInteractionType;
    position: number;
    occurredAt: string;
}

export interface RankingSyntheticRow {
    datasetVersion: 'ranking-synthetic-v1';
    featureSchemaVersion: 'ranking-features-v1';
    userId: string;
    sessionId: string;
    requestId: string;
    itemId: string;
    position: number;
    features: number[];
    label: 0 | 1;
    eventType: SyntheticInteractionType;
    split: SyntheticDatasetSplit;
}

export interface RankingSyntheticDataset {
    catalog: RecommendationCatalogProduct[];
    personas: RankingSyntheticPersona[];
    sessions: RankingSyntheticSession[];
    events: RankingSyntheticEvent[];
    rows: RankingSyntheticRow[];
}
