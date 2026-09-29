// Unit test cho simulator offline; test không mở database, không gọi network và không ghi dữ liệu nghiệp vụ.

import { ConfigService } from '@nestjs/config';
import { RecommendationRuleService } from '@/modules/profiles/application/services/rules/recommendation-rule.service';
import { RankingFeatureService } from '@/modules/recommendation/application/services/ranking/features/ranking-feature.service';
import { RankingSimulationService } from '@/modules/recommendation/application/services/offline/ranking-simulation.service';
import type { RecommendationCatalogProduct } from '@/modules/catalog/application/types/catalog-product.type';
import type { RankingSyntheticOptions } from '@/modules/recommendation/application/types/offline/ranking-synthetic.types';

describe('RankingSimulationService', () => {
    let target: RankingSimulationService;

    // Tạo catalog fixture đủ category/brand/quality để simulator chạy qua toàn bộ feature builder production.
    const createCatalog = (count = 12): RecommendationCatalogProduct[] =>
        Array.from({ length: count }, (_, index) => ({
            productId: `product-${String(index + 1).padStart(3, '0')}`,
            originType: 'EXTERNAL',
            name: `Product ${index + 1}`,
            slug: `product-${index + 1}`,
            imageUrl: null,
            categoryId: `category-${index % 3}`,
            brandId: `brand-${index % 4}`,
            sellerShopId: null,
            externalShopId: `external-shop-${index % 2}`,
            minPrice: String(100_000 + index * 25_000),
            maxPrice: String(120_000 + index * 25_000),
            ratingAvg: String(3.5 + (index % 4) * 0.3),
            reviewCount: 10 + index * 3,
            totalSold: 5 + index * 10,
            status: 'ACTIVE',
            isInStock: true,
            createdAt: new Date('2025-12-01T00:00:00.000Z'),
            updatedAt: new Date('2025-12-01T00:00:00.000Z'),
            catalogVersion: '1',
            shortDescription: null,
            description: null,
            brandName: `Brand ${index % 4}`,
            categoryPath: `Category ${index % 3}`,
            semanticAttributes: [],
            contentHash: null,
            embeddingStatus: 'NOT_REQUIRED',
            embeddingModelVersion: null,
            embeddingDimensions: null,
        }));

    // Dùng option cố định để các test kiểm tra reproducibility không phụ thuộc đồng hồ hệ thống.
    const createOptions = (
        overrides: Partial<RankingSyntheticOptions> = {},
    ): RankingSyntheticOptions => ({
        users: 10,
        sessions: 20,
        targetEvents: 160,
        seed: 42,
        referenceTime: new Date('2026-01-01T00:00:00.000Z'),
        ...overrides,
    });

    beforeEach(() => {
        const rules = new RecommendationRuleService(new ConfigService());
        target = new RankingSimulationService(new RankingFeatureService(rules));
    });

    // Kiểm tra cùng seed và reference time tạo đúng cùng output để dataset có thể audit/retrain lại.
    it('should generate the same dataset when seed and clock are unchanged', () => {
        // Arrange
        const catalog = createCatalog();
        const options = createOptions();

        // Act
        const first = target.generate(catalog, options);
        const second = target.generate(catalog, options);

        // Assert
        expect(second).toEqual(first);
    });

    // Kiểm tra feature contract, split và label balance tối thiểu ở từng recommendation request.
    it('should create bounded nine-feature rows with positive and negative items per request', () => {
        // Arrange
        const dataset = target.generate(createCatalog(), createOptions());
        const rowsByRequest = new Map<string, typeof dataset.rows>();

        // Act
        for (const row of dataset.rows) {
            const rows = rowsByRequest.get(row.requestId) ?? [];
            rows.push(row);
            rowsByRequest.set(row.requestId, rows);
        }

        // Assert
        expect(dataset.sessions).toHaveLength(20);
        expect(dataset.events.length).toBeGreaterThan(160);
        expect(dataset.rows.every((row) => row.features)).toBe(true);
        expect(
            dataset.rows.every(
                (row) =>
                    row.features.length === 9 &&
                    row.features.every((value) => value >= 0 && value <= 1),
            ),
        ).toBe(true);
        expect(
            [...rowsByRequest.values()].every(
                (rows) =>
                    rows.some((row) => row.label === 1) &&
                    rows.some((row) => row.label === 0),
            ),
        ).toBe(true);
        expect(new Set(dataset.rows.map((row) => row.requestId)).size).toBe(20);
    });

    // Kiểm tra split theo timeline để cùng session không bị trộn giữa train, validation và test.
    it('should split rows by session order without overlapping request IDs', () => {
        // Arrange
        const dataset = target.generate(createCatalog(), createOptions());

        // Act
        const requestIdsBySplit = new Map<string, Set<string>>();
        for (const row of dataset.rows) {
            const requestIds =
                requestIdsBySplit.get(row.split) ?? new Set<string>();
            requestIds.add(row.requestId);
            requestIdsBySplit.set(row.split, requestIds);
        }

        // Assert
        expect(requestIdsBySplit.get('train')?.size).toBe(14);
        expect(requestIdsBySplit.get('validation')?.size).toBe(3);
        expect(requestIdsBySplit.get('test')?.size).toBe(3);
        expect(
            [...(requestIdsBySplit.get('train') ?? [])].some((id) =>
                (requestIdsBySplit.get('validation') ?? new Set()).has(id),
            ),
        ).toBe(false);
    });

    // Kiểm tra catalog không đủ candidate bị từ chối thay vì sinh dataset thiếu contract.
    it('should reject a catalog with fewer than eight products', () => {
        // Arrange
        const catalog = createCatalog(7);

        // Act & Assert
        expect(() => target.generate(catalog, createOptions())).toThrow(
            'SYNTHETIC_CATALOG_REQUIRES_8_PRODUCTS',
        );
    });
});
