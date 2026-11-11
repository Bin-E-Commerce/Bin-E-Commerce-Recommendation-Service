// Kiểm tra thứ tự khóa duy nhất và ranh giới impression của session context dùng cho feature ranking.

import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { createMock, type DeepMocked } from '@golevelup/ts-jest';
import { RecommendationRedisService } from '@/infrastructure/redis/redis.module';
import type { RecommendationInteractionRecordedEvent } from '@/modules/interactions/application/types/interaction-event.types';
import { RecommendationRuleService } from '@/modules/profiles/application/services/rules/recommendation-rule.service';
import { SessionContextService } from '@/modules/profiles/application/services/session/session-context.service';
import type { SessionContext } from '@/modules/profiles/application/types/profile.types';

// Logger giả chỉ phục vụ TestingModule, không ghi log hoặc gọi hạ tầng ngoài.
class MockLoggerService {
    log(): void {}
    error(): void {}
    warn(): void {}
    debug(): void {}
    verbose(): void {}
    setContext(): void {}
}

describe('SessionContextService', () => {
    let target: SessionContextService;
    let mockRedis: DeepMocked<RecommendationRedisService>;
    let mockRules: DeepMocked<RecommendationRuleService>;
    let stored: SessionContext | null;

    // Dựng event tối thiểu cùng session, giữ timestamp tường minh để kiểm tra thứ tự xử lý.
    const createEvent = (
        interactionType: RecommendationInteractionRecordedEvent['data']['interactionType'],
        productId: string,
        categoryId: string,
        second: number,
    ): RecommendationInteractionRecordedEvent => ({
        eventId: `event-${second}`,
        eventName: 'recommendation.interaction.recorded',
        eventVersion: 1,
        source: 'recommendation-service',
        occurredAt: `2026-11-09T00:00:${String(second).padStart(2, '0')}.000Z`,
        aggregateId: 'session-1',
        data: {
            interactionType,
            userId: null,
            sessionId: 'session-1',
            productId,
            variantId: null,
            categoryId,
            query: null,
            page: null,
            position: null,
            quantity: null,
            requestId: null,
        },
    });

    beforeEach(async () => {
        stored = null;
        mockRedis = createMock<RecommendationRedisService>();
        mockRules = createMock<RecommendationRuleService>();
        const mockConfig = createMock<ConfigService>();
        mockConfig.get.mockImplementation(
            (key: string, fallback?: unknown) =>
                (key === 'RECOMMENDATION_SESSION_MAX_RECENT_ITEMS'
                    ? '2'
                    : fallback) as never,
        );
        mockRules.getInteractionWeight.mockReturnValue(1);
        mockRedis.getJson.mockImplementation(async () => stored);
        mockRedis.compareAndSetJson.mockImplementation(
            async (_key, _version, next) => {
                stored = next as SessionContext;
                return true;
            },
        );

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                SessionContextService,
                { provide: RecommendationRedisService, useValue: mockRedis },
                { provide: RecommendationRuleService, useValue: mockRules },
                { provide: ConfigService, useValue: mockConfig },
            ],
        })
            .setLogger(new MockLoggerService())
            .compile();
        target = module.get<SessionContextService>(SessionContextService);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    // Tương tác lại đưa khóa lên đầu; giới hạn hai mục loại khóa cũ và giữ danh sách không trùng.
    it('should keep recent category and brand keys unique and ordered', async () => {
        // Arrange / Act
        await target.apply(
            createEvent('PRODUCT_VIEWED', 'product-1', 'category-1', 1),
            'category-1',
            'brand-1',
        );
        await target.apply(
            createEvent('PRODUCT_VIEWED', 'product-2', 'category-2', 2),
            'category-2',
            'brand-2',
        );
        await target.apply(
            createEvent('PRODUCT_CLICKED', 'product-1', 'category-1', 3),
            'category-1',
            'brand-1',
        );

        // Assert
        expect(stored?.recentCategoryIds).toEqual(['category-1', 'category-2']);
        expect(stored?.recentBrandIds).toEqual(['brand-1', 'brand-2']);

        // Act: khóa thứ ba đẩy khóa cũ nhất khỏi cửa sổ hai mục.
        await target.apply(
            createEvent('PRODUCT_VIEWED', 'product-3', 'category-3', 4),
            'category-3',
            'brand-3',
        );

        // Assert
        expect(stored?.recentCategoryIds).toEqual(['category-3', 'category-1']);
        expect(stored?.recentBrandIds).toEqual(['brand-3', 'brand-1']);
        expect(mockRedis.compareAndSetJson).toHaveBeenCalledTimes(4);
    });

    // Impression chỉ ghi hiển thị nên không được xem là bằng chứng người dùng vừa chủ động quan tâm.
    it('should not change recent attributes after a passive impression', async () => {
        // Arrange
        await target.apply(
            createEvent('PRODUCT_VIEWED', 'product-1', 'category-1', 1),
            'category-1',
            'brand-1',
        );

        // Act
        await target.apply(
            createEvent('PRODUCT_IMPRESSED', 'product-2', 'category-2', 2),
            'category-2',
            'brand-2',
        );

        // Assert
        expect(stored?.recentCategoryIds).toEqual(['category-1']);
        expect(stored?.recentBrandIds).toEqual(['brand-1']);
        expect(stored?.currentProductId).toBe('product-1');
        expect(mockRedis.compareAndSetJson).toHaveBeenCalledTimes(2);
    });
});
