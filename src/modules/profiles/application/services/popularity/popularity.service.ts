// Service này chuyển interaction/purchase event thành popularity signal; mọi truy vấn aggregate thuộc PopularityRepository.

import { Injectable } from '@nestjs/common';
import type { RecommendationInteractionRecordedEvent } from '@/modules/interactions/application/types/interaction-event.types';
import type { OrderPurchaseEvent } from '@common/kafka/events/order.events';
import { PopularityRepository } from '@/modules/profiles/infrastructure/repositories/popularity.repository';

// Application service tính signal từ event và giao persistence cho repository để giữ boundary rõ ràng.
@Injectable()
export class PopularityService {
    constructor(private readonly repository: PopularityRepository) {}

    // Tính views/clicks/cart adds theo interaction type rồi cập nhật aggregate trong transaction projection hiện tại.
    async applyInteraction(
        event: RecommendationInteractionRecordedEvent,
        manager?: import('typeorm').EntityManager,
    ): Promise<void> {
        const productId = event.data.productId;
        if (!productId) return;

        const quantity = event.data.quantity ?? 1;
        const views =
            event.data.interactionType === 'PRODUCT_VIEWED' ||
            event.data.interactionType === 'PRODUCT_IMPRESSED'
                ? 1
                : 0;
        const clicks = event.data.interactionType === 'PRODUCT_CLICKED' ? 1 : 0;
        const cartAdds =
            event.data.interactionType === 'PRODUCT_ADDED_TO_CART'
                ? quantity
                : 0;

        await this.repository.incrementInteraction(
            { productId, views, clicks, cartAdds },
            manager,
        );
    }

    // Xác định purchase hay return rồi giao quantity có dấu cho repository cập nhật aggregate an toàn.
    async applyPurchase(
        event: OrderPurchaseEvent,
        manager?: import('typeorm').EntityManager,
    ): Promise<void> {
        const isReturn = event.eventName === 'order.purchase.returned';
        const occurredAt = new Date(event.data.occurredAt);
        if (Number.isNaN(occurredAt.getTime())) {
            throw new Error('INVALID_PURCHASE_OCCURRED_AT');
        }
        for (const item of event.data.items) {
            await this.repository.incrementPurchase(
                {
                    eventId: event.eventId,
                    productId: item.productId,
                    quantity: item.quantity,
                    isReturn,
                    occurredAt,
                },
                manager,
            );
        }
    }
}
