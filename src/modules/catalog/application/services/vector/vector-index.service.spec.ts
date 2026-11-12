// Unit test cho adapter Qdrant; kiểm tra metric/dimension active collection trước khi semantic source phục vụ.

import { ConfigService } from '@nestjs/config';
import { VectorIndexService } from '@/modules/catalog/application/services/vector/vector-index.service';

describe('VectorIndexService', () => {
    let originalFetch: typeof fetch;
    let mockFetch: jest.MockedFunction<typeof fetch>;

    // Thay fetch mạng bằng mock để kiểm thử hợp đồng collection mà không cần Qdrant thật.
    beforeEach(() => {
        originalFetch = global.fetch;
        mockFetch = jest.fn();
        global.fetch = mockFetch;
    });

    // Khôi phục global sau mỗi ca để không rò mock sang spec khác.
    afterEach(() => {
        global.fetch = originalFetch;
        jest.clearAllMocks();
    });

    // Tạo ConfigService nhỏ cho các kiểm tra cấu hình constructor; key không liên quan nhận default.
    function createConfig(distance: string = 'Cosine'): ConfigService {
        return {
            get: jest.fn((key: string, defaultValue?: string) =>
                key === 'QDRANT_DISTANCE' ? distance : defaultValue,
            ),
        } as unknown as ConfigService;
    }

    // Tạo Response JSON tối thiểu cho fetch mock để khớp đường khởi tạo collection.
    function createJsonResponse(body: unknown): Response {
        return {
            ok: true,
            status: 200,
            json: async () => body,
        } as Response;
    }

    // Metric khác cosine không tương thích; chỉ semantic source fail-soft để các nguồn còn lại vẫn phục vụ.
    it.each(['Dot', 'Euclid'])(
        'should keep vector search unavailable for the unsupported %s distance metric',
        async (distance) => {
            // Arrange
            const target = new VectorIndexService(createConfig(distance));

            // Act
            const ready = await target.ensureCollection();

            // Assert
            expect(ready).toBe(false);
            expect(mockFetch).not.toHaveBeenCalled();
        },
    );

    // Collection vật lý và alias đang phục vụ cùng Cosine thì adapter được phép bật search.
    it('should initialize vector search when the active collection uses cosine', async () => {
        // Arrange
        const target = new VectorIndexService(createConfig());
        mockFetch
            .mockResolvedValueOnce(createJsonResponse({ result: {} }))
            .mockResolvedValueOnce(
                createJsonResponse({
                    result: {
                        aliases: [
                            {
                                alias_name:
                                    'recommendation_product_embeddings_current',
                                collection_name:
                                    'recommendation_product_embeddings_current_v1',
                            },
                        ],
                    },
                }),
            )
            .mockResolvedValueOnce(
                createJsonResponse({
                    result: {
                        points_count: 10,
                        config: {
                            params: {
                                vectors: { size: 1536, distance: 'Cosine' },
                            },
                        },
                    },
                }),
            );

        // Act
        const ready = await target.ensureCollection();

        // Assert
        expect(ready).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    // Alias cũ có thể tiếp tục phục vụ sau deploy; kiểm tra metric thật của collection đó trước khi bật search.
    it('should keep semantic search unavailable when the active alias uses Euclid', async () => {
        // Arrange
        const target = new VectorIndexService(createConfig());
        mockFetch
            .mockResolvedValueOnce(createJsonResponse({ result: {} }))
            .mockResolvedValueOnce(
                createJsonResponse({
                    result: {
                        aliases: [
                            {
                                alias_name:
                                    'recommendation_product_embeddings_current',
                                collection_name: 'legacy-euclid-collection',
                            },
                        ],
                    },
                }),
            )
            .mockResolvedValueOnce(
                createJsonResponse({
                    result: {
                        points_count: 10,
                        config: {
                            params: {
                                vectors: { size: 1536, distance: 'Cosine' },
                            },
                        },
                    },
                }),
            )
            .mockResolvedValueOnce(
                createJsonResponse({
                    result: {
                        points_count: 10,
                        config: {
                            params: {
                                vectors: { size: 1536, distance: 'Euclid' },
                            },
                        },
                    },
                }),
            );

        // Act
        const ready = await target.ensureCollection();

        // Assert
        expect(ready).toBe(false);
        expect(mockFetch).toHaveBeenCalledTimes(4);
    });
});
