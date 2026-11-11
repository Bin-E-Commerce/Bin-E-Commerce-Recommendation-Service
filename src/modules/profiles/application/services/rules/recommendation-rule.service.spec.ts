// Unit tests bảo vệ policy weight/decay config để thay đổi rule không âm thầm làm sai profile projection.
/// <reference types="jest" />

import { ConfigService } from '@nestjs/config';
import { RecommendationRuleService } from '@/modules/profiles/application/services/rules/recommendation-rule.service';

describe('RecommendationRuleService', () => {
    let target: RecommendationRuleService;

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('should return configured weight and rule version', () => {
        // Arrange
        const config = {
            get: jest.fn(
                (key: string, fallback?: string) =>
                    ({
                        RECOMMENDATION_WEIGHT_PRODUCT_CLICKED: '3',
                        RECOMMENDATION_RANKING_POLICY_VERSION:
                            'ai-lambdarank-test-v1',
                    })[key] ?? fallback,
            ),
        } as unknown as ConfigService;
        target = new RecommendationRuleService(config);

        // Act
        const weight = target.getInteractionWeight('PRODUCT_CLICKED');
        const version = target.getRuleVersion();

        // Assert
        expect(weight).toBe(3);
        expect(version).toBe('ai-lambdarank-test-v1');
    });

    // Half-life đã được dùng để ghi aggregate nên đổi ENV phải dừng service cho đến khi phát lại lịch sử.
    it('should reject a changed or invalid half-life configuration', () => {
        // Arrange
        const config = {
            get: jest.fn((key: string) =>
                key === 'RECOMMENDATION_PROFILE_HALF_LIFE_DAYS'
                    ? '14'
                    : undefined,
            ),
        } as unknown as ConfigService;

        // Act & Assert
        expect(() => new RecommendationRuleService(config)).toThrow(
            'PROFILE_HALF_LIFE_CHANGE_REQUIRES_PROFILE_REPLAY',
        );
    });

    // Không khai báo override vẫn dùng đúng half-life cố định đã dùng cho projection mới.
    it('should use the pinned seven-day half-life when no override is set', () => {
        // Arrange
        const config = {
            get: jest.fn(() => undefined),
        } as unknown as ConfigService;
        target = new RecommendationRuleService(config);

        // Act
        const halfLifeDays = target.getProfileHalfLifeDays();

        // Assert
        expect(halfLifeDays).toBe(7);
    });

    it('should normalize profile dimension weights and reject invalid scales', () => {
        // Arrange: hai trọng số không còn tổng 1 và scale không hợp lệ phải quay về mặc định.
        const config = {
            get: jest.fn(
                (key: string, fallback?: string) =>
                    ({
                        RECOMMENDATION_PROFILE_PRODUCT_WEIGHT: '2',
                        RECOMMENDATION_PROFILE_CATEGORY_WEIGHT: '1',
                        RECOMMENDATION_PROFILE_BRAND_WEIGHT: '0',
                        RECOMMENDATION_PROFILE_CATEGORY_SCALE: '-1',
                    })[key] ?? fallback,
            ),
        } as unknown as ConfigService;
        target = new RecommendationRuleService(config);

        // Act
        const affinity = target.getProfileAffinityConfig();

        // Assert
        expect(affinity.product.weight).toBeCloseTo(2 / 3);
        expect(affinity.category.weight).toBeCloseTo(1 / 3);
        expect(affinity.brand.weight).toBe(0);
        expect(affinity.category.scale).toBe(16);
    });

    // Từng weight hữu hạn cực lớn vẫn phải chuẩn hóa được thay vì tràn tổng thành Infinity rồi thành toàn số 0.
    it('should normalize very large finite profile weights without overflow', () => {
        // Arrange
        const config = {
            get: jest.fn(
                (key: string, fallback?: string) =>
                    (key.endsWith('_WEIGHT') ? '1e308' : undefined) ?? fallback,
            ),
        } as unknown as ConfigService;
        target = new RecommendationRuleService(config);

        // Act
        const affinity = target.getProfileAffinityConfig();

        // Assert
        expect(affinity.product.weight).toBeCloseTo(1 / 3);
        expect(affinity.category.weight).toBeCloseTo(1 / 3);
        expect(affinity.brand.weight).toBeCloseTo(1 / 3);
        expect(
            affinity.product.weight +
                affinity.category.weight +
                affinity.brand.weight,
        ).toBeCloseTo(1);
    });

    it('should keep purchase and return weights configurable with their expected signs', () => {
        // Arrange
        const config = {
            get: jest.fn(
                (key: string, fallback?: string) =>
                    ({
                        RECOMMENDATION_WEIGHT_PURCHASE_COMPLETED: '10',
                        RECOMMENDATION_WEIGHT_PURCHASE_RETURNED: '2',
                    })[key] ?? fallback,
            ),
        } as unknown as ConfigService;
        target = new RecommendationRuleService(config);

        // Act
        const completedWeight = target.getPurchaseWeight(
            'order.purchase.completed',
        );
        const returnedWeight = target.getPurchaseWeight(
            'order.purchase.returned',
        );

        // Assert
        expect(completedWeight).toBe(10);
        expect(returnedWeight).toBe(-8);
    });

    it('should expose candidate source status from environment master switches', () => {
        // Arrange
        const config = {
            get: jest.fn(
                (key: string, fallback?: string) =>
                    ({
                        CANDIDATE_PIPELINE_V3_ENABLED: 'true',
                        SEMANTIC_CANDIDATES_ENABLED: 'true',
                        CO_BEHAVIOR_CANDIDATES_ENABLED: 'false',
                    })[key] ?? fallback,
            ),
        } as unknown as ConfigService;
        target = new RecommendationRuleService(config);
        target.setRuntimePolicy({ version: 'policy-v2' });

        // Act
        const status = target.getCandidateSourceStatus();

        // Assert
        expect(status.semanticEnabled).toBe(true);
        expect(status.coBehaviorEnabled).toBe(false);
        expect(status.coBehaviorMasterEnabled).toBe(false);
    });

    it('should default candidate sources to enabled when environment flags are absent', () => {
        // Arrange
        const config = {
            get: jest.fn((_key: string, fallback?: string) => fallback),
        } as unknown as ConfigService;
        target = new RecommendationRuleService(config);

        // Act
        const status = target.getCandidateSourceStatus();

        // Assert
        expect(status).toEqual({
            semanticEnabled: true,
            coBehaviorEnabled: true,
            semanticMasterEnabled: true,
            coBehaviorMasterEnabled: true,
            pipelineMasterEnabled: true,
        });
    });
});
