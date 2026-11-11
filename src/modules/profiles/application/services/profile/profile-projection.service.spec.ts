// Unit test bảo vệ event purchase/return ánh xạ đủ các chiều hồ sơ mà không cần database thật.

import { Test, type TestingModule } from '@nestjs/testing';
import { createMock, type DeepMocked } from '@golevelup/ts-jest';
import type { EntityManager } from 'typeorm';
import {
    OrderEvents,
    type OrderPurchaseEvent,
} from '@common/kafka/events/order.events';
import { RecommendationRedisService } from '@/infrastructure/redis/redis.module';
import { CatalogService } from '@/modules/catalog/application/services/catalog/catalog.service';
import { PopularityService } from '@/modules/profiles/application/services/popularity/popularity.service';
import { ProfileProjectionService } from '@/modules/profiles/application/services/profile/profile-projection.service';
import { RecommendationRuleService } from '@/modules/profiles/application/services/rules/recommendation-rule.service';
import { SessionContextService } from '@/modules/profiles/application/services/session/session-context.service';
import { ProfileProjectionRepository } from '@/modules/profiles/infrastructure/repositories/profile-projection.repository';

class MockLoggerService {
    log(): void {}
    error(): void {}
    warn(): void {}
    debug(): void {}
    verbose(): void {}
    setContext(): void {}
}

// Tạo event v1 tối thiểu để hai test kiểm tra cả mua thành công và hoàn hàng.
function createPurchaseEvent(
    eventName: OrderPurchaseEvent['eventName'],
): OrderPurchaseEvent {
    const occurredAt = '2026-11-01T00:00:00.000Z';
    return {
        eventId: `${eventName}:order-1`,
        eventName,
        eventVersion: 1,
        source: 'order-service',
        occurredAt,
        aggregateId: 'order-1',
        data: {
            orderId: 'order-1',
            customerUserId: 'user-1',
            occurredAt,
            items: [
                {
                    orderItemId: 'order-item-1',
                    productId: 'product-1',
                    variantId: 'variant-1',
                    categoryId: 'category-1',
                    brandId: 'brand-1',
                    quantity: 2,
                },
            ],
        },
    };
}

describe('ProfileProjectionService projectPurchase', () => {
    let target: ProfileProjectionService;
    let mockProjectionRepository: DeepMocked<ProfileProjectionRepository>;
    let mockCatalog: DeepMocked<CatalogService>;
    let mockSessionContext: DeepMocked<SessionContextService>;
    let mockPopularity: DeepMocked<PopularityService>;
    let mockRedis: DeepMocked<RecommendationRedisService>;
    let mockRules: DeepMocked<RecommendationRuleService>;

    // Mỗi test nhận dependency mới; transaction chạy callback với manager giả và projection repository được mock.
    beforeEach(async () => {
        mockProjectionRepository = createMock<ProfileProjectionRepository>();
        mockCatalog = createMock<CatalogService>();
        mockSessionContext = createMock<SessionContextService>();
        mockPopularity = createMock<PopularityService>();
        mockRedis = createMock<RecommendationRedisService>();
        mockRules = createMock<RecommendationRuleService>();
        mockProjectionRepository.transaction.mockImplementation(async (work) =>
            work({} as EntityManager),
        );
        mockProjectionRepository.claimProjectionEvent.mockResolvedValue(true);
        mockRules.getProfileHalfLifeDays.mockReturnValue(7);

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ProfileProjectionService,
                {
                    provide: ProfileProjectionRepository,
                    useValue: mockProjectionRepository,
                },
                { provide: CatalogService, useValue: mockCatalog },
                {
                    provide: SessionContextService,
                    useValue: mockSessionContext,
                },
                { provide: PopularityService, useValue: mockPopularity },
                { provide: RecommendationRedisService, useValue: mockRedis },
                { provide: RecommendationRuleService, useValue: mockRules },
            ],
        })
            .setLogger(new MockLoggerService())
            .compile();

        target = module.get<ProfileProjectionService>(ProfileProjectionService);
    });

    // Gỡ call history sau mỗi case để khẳng định từng event chỉ tạo preference của chính nó.
    afterEach(() => {
        jest.clearAllMocks();
    });

    // Purchase phải tăng product, category và brand bằng quantity cùng một weight.
    it('should project a completed purchase into all three profile dimensions', async () => {
        // Arrange
        mockRules.getPurchaseWeight.mockReturnValue(8);

        // Act
        await target.projectPurchase(
            createPurchaseEvent(OrderEvents.PURCHASE_COMPLETED),
        );

        // Assert
        expect(mockProjectionRepository.upsertPreference).toHaveBeenCalledTimes(
            3,
        );
        expect(mockProjectionRepository.upsertPreference).toHaveBeenCalledWith(
            expect.objectContaining({
                dimension: 'BRAND',
                dimensionKey: 'brand-1',
                score: 16,
                halfLifeDays: 7,
            }),
            expect.anything(),
        );
    });

    // Return phải ghi brand trong cùng chiều âm để penalty phản ánh hàng đã hoàn.
    it('should project a returned purchase as negative brand evidence', async () => {
        // Arrange
        mockRules.getPurchaseWeight.mockReturnValue(-8);

        // Act
        await target.projectPurchase(
            createPurchaseEvent(OrderEvents.PURCHASE_RETURNED),
        );

        // Assert
        expect(mockProjectionRepository.upsertPreference).toHaveBeenCalledWith(
            expect.objectContaining({
                dimension: 'BRAND',
                dimensionKey: 'brand-1',
                score: -16,
                halfLifeDays: 7,
            }),
            expect.anything(),
        );
    });

    // Sự kiện cũ không có brand snapshot vẫn cập nhật product/category và không tạo khóa brand rỗng.
    it('should preserve compatibility when an older purchase event has no brand', async () => {
        // Arrange
        mockRules.getPurchaseWeight.mockReturnValue(8);
        const event = createPurchaseEvent(OrderEvents.PURCHASE_COMPLETED);
        delete event.data.items[0]!.brandId;

        // Act
        await target.projectPurchase(event);

        // Assert
        expect(mockProjectionRepository.upsertPreference).toHaveBeenCalledTimes(
            2,
        );
        expect(
            mockProjectionRepository.upsertPreference,
        ).not.toHaveBeenCalledWith(
            expect.objectContaining({ dimension: 'BRAND' }),
            expect.anything(),
        );
    });
});
