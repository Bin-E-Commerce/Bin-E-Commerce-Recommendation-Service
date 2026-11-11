// Unit tests bảo vệ LambdaRank feature schema, raw score và fail-closed behavior.
/// <reference types="jest" />

import { ServiceUnavailableException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { createMock, type DeepMocked } from '@golevelup/ts-jest';
import { RankingFeatureService } from '@/modules/recommendation/application/services/ranking/features/ranking-feature.service';
import type { RecommendationCandidate } from '@/modules/recommendation/application/types/ranking/ranking.types';
import { RecommendationMlRankingService } from '@/modules/recommendation/application/services/ranking/ml/recommendation-ml-ranking.service';

class MockLoggerService {
    log(): void {}
    error(): void {}
    warn(): void {}
    debug(): void {}
    verbose(): void {}
    setContext(): void {}
}

describe('RecommendationMlRankingService', () => {
    let target: RecommendationMlRankingService;
    let mockConfig: DeepMocked<ConfigService>;
    let mockFeatures: DeepMocked<RankingFeatureService>;

    const featureVector = {
        profileAffinity: 0.2,
        sessionContext: 0.1,
        semanticSimilarity: 0.3,
        coBehavior: 0.1,
        popularity: 0.1,
        freshness: 0.1,
        quality: 0.1,
        exploration: 0,
        negativePenalty: 0,
    };

    // Tạo candidate tối thiểu để adapter test batch mapping độc lập với catalog persistence.
    const createCandidate = (productId: string): RecommendationCandidate =>
        ({
            product: { productId },
            sources: new Set(['TRENDING']),
        }) as RecommendationCandidate;

    beforeEach(async () => {
        mockConfig = createMock<ConfigService>();
        mockFeatures = createMock<RankingFeatureService>();
        mockConfig.get.mockImplementation((key: string, fallback?: unknown) => {
            const values: Record<string, string> = {
                AI_SERVICE_URL: 'http://ai.test',
                INTERNAL_SERVICE_TOKEN: 'test-token',
                ML_RANKING_TIMEOUT_MS: '150',
            };
            return (values[key] ?? fallback) as never;
        });
        mockFeatures.createPreferenceLookup.mockReturnValue({
            product: new Map(),
            category: new Map(),
            brand: new Map(),
        });
        mockFeatures.build.mockReturnValue(featureVector);

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                RecommendationMlRankingService,
                { provide: ConfigService, useValue: mockConfig },
                { provide: RankingFeatureService, useValue: mockFeatures },
            ],
        })
            .setLogger(new MockLoggerService())
            .compile();

        target = module.get<RecommendationMlRankingService>(
            RecommendationMlRankingService,
        );
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.clearAllMocks();
    });

    // Raw score có thể âm hoặc lớn hơn một; adapter giữ nguyên vì đây không phải xác suất.
    // Request phải ghi schema v3 để AI service từ chối vector từ công thức phiên cũ.
    it('should preserve LambdaRank raw relevance scores and map them to candidate IDs', async () => {
        // Arrange
        const mockFetch = jest.spyOn(global, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => ({
                modelVersion: 'ranking-lambdarank-v2',
                predictions: [
                    { itemId: 'product-1', score: -0.4 },
                    { itemId: 'product-2', score: 2.3 },
                ],
            }),
        } as Response);

        // Act
        const result = await target.predict({
            requestId: 'request-1',
            candidates: [
                createCandidate('product-1'),
                createCandidate('product-2'),
            ],
            products: [],
            categories: [],
            brands: [],
            context: null,
        });

        // Assert
        expect(result.modelVersion).toBe('ranking-lambdarank-v2');
        expect(result.scores).toEqual(
            new Map([
                ['product-1', -0.4],
                ['product-2', 2.3],
            ]),
        );
        expect(result.features).toEqual(
            new Map([
                ['product-1', featureVector],
                ['product-2', featureVector],
            ]),
        );
        const request = mockFetch.mock.calls[0]?.[1];
        expect(JSON.parse(String(request?.body))).toMatchObject({
            requestId: 'request-1',
            featureSchemaVersion: 'ranking-features-v3',
        });
    });

    // Lỗi mạng không được trả điểm rỗng để query tự hiểu nhầm là ranker khác đã phục vụ.
    it('should fail with service unavailable when the AI service request fails', async () => {
        // Arrange
        const mockFetch = jest
            .spyOn(global, 'fetch')
            .mockRejectedValue(new Error('AI service unavailable'));

        // Act / Assert
        await expect(
            target.predict({
                requestId: 'request-1',
                candidates: [createCandidate('product-1')],
                products: [],
                categories: [],
                brands: [],
                context: null,
            }),
        ).rejects.toThrow(ServiceUnavailableException);
        expect(mockFetch).toHaveBeenCalledWith(
            'http://ai.test/api/v1/ranking/predict',
            expect.objectContaining({ method: 'POST' }),
        );
    });

    // Artifact fallback cũ không thể được attribue nhầm thành một model LambdaRank.
    it('should reject the legacy fallback model version', async () => {
        // Arrange
        jest.spyOn(global, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => ({
                modelVersion: 'ranking-fallback-v1',
                predictions: [{ itemId: 'product-1', score: 0.95 }],
            }),
        } as Response);

        // Act / Assert
        await expect(
            target.predict({
                requestId: 'request-1',
                candidates: [createCandidate('product-1')],
                products: [],
                categories: [],
                brands: [],
                context: null,
            }),
        ).rejects.toThrow(ServiceUnavailableException);
    });

    // Batch thiếu prediction không được xếp một phần vì so sánh sẽ mất cùng một candidate set.
    it('should reject an incomplete prediction batch', async () => {
        // Arrange
        jest.spyOn(global, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => ({
                modelVersion: 'ranking-lambdarank-v2',
                predictions: [{ itemId: 'product-1', score: 0.95 }],
            }),
        } as Response);

        // Act / Assert
        await expect(
            target.predict({
                requestId: 'request-1',
                candidates: [
                    createCandidate('product-1'),
                    createCandidate('product-2'),
                ],
                products: [],
                categories: [],
                brands: [],
                context: null,
            }),
        ).rejects.toThrow(ServiceUnavailableException);
    });

    // Status hiển thị readiness thật của artifact, không còn trạng thái fallback.
    it('should expose a ready model status to Admin', async () => {
        // Arrange
        jest.spyOn(global, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => ({
                ready: true,
                modelVersion: 'ranking-lambdarank-v2',
                featureCount: 9,
            }),
        } as Response);

        // Act
        const result = await target.getStatus();

        // Assert
        expect(result).toEqual({
            ready: true,
            modelVersion: 'ranking-lambdarank-v2',
            featureCount: 9,
            reachable: true,
        });
    });

    // AI service timeout được báo không reachable, không gắn nhãn model fallback.
    it('should report an unreachable AI service without a fallback mode', async () => {
        // Arrange
        jest.spyOn(global, 'fetch').mockRejectedValue(new Error('timeout'));

        // Act
        const result = await target.getStatus();

        // Assert
        expect(result).toEqual({
            ready: false,
            modelVersion: null,
            featureCount: null,
            reachable: false,
        });
    });
});
