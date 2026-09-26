import { Injectable } from '@nestjs/common';
import type { RecommendationInteractionRecordedEvent } from '@common/kafka/events/recommendation.events';
import type { RecommendationPurchaseEvent } from '@common/kafka/events/recommendation.events';
import {
    RelationRepository,
    type RelationType,
} from '@/modules/relations/infrastructure/repositories/relation.repository';
import { RecommendationRuleService } from '@/modules/profiles/application/services/rules/recommendation-rule.service';

// Application policy cho co-view/co-cart/co-purchase; consumer chỉ parse event rồi ủy quyền logic tại đây.
@Injectable()
export class RelationProjectionService {
    constructor(
        private readonly repository: RelationRepository,
        private readonly rules: RecommendationRuleService,
    ) {}

    // Project interaction vào directed pairs bounded theo session/user window; duplicate event được ledger bỏ qua.
    async projectInteraction(
        event: RecommendationInteractionRecordedEvent,
    ): Promise<void> {
        const productId = event.data.productId;
        if (!productId) return;
        const type = this.toRelationType(event.data.interactionType);
        if (!type) return;
        const occurredAt = new Date(event.occurredAt);
        if (Number.isNaN(occurredAt.getTime()))
            throw new Error('INVALID_INTERACTION_OCCURRED_AT');
        const windowMs =
            type === 'CO_VIEW' ? 30 * 60_000 : 7 * 24 * 60 * 60_000;
        const types =
            type === 'CO_VIEW'
                ? ['PRODUCT_VIEWED', 'PRODUCT_CLICKED', 'PRODUCT_IMPRESSED']
                : ['PRODUCT_ADDED_TO_CART'];
        const weight = this.rules.getRelationWeight(
            event.data.interactionType as
                | 'PRODUCT_VIEWED'
                | 'PRODUCT_CLICKED'
                | 'PRODUCT_IMPRESSED'
                | 'PRODUCT_ADDED_TO_CART',
        );
        await this.repository.withProjection(
            event.eventId,
            type,
            async (manager) => {
                await this.repository.insertSignal(
                    {
                        eventId: event.eventId,
                        userId: event.data.userId,
                        sessionId: event.data.sessionId,
                        interactionType: event.data.interactionType,
                        productId,
                        occurredAt,
                    },
                    manager,
                );
                const relatedSignals = await this.repository.findRecentSignals(
                    {
                        userId: event.data.userId,
                        sessionId: event.data.sessionId,
                        relationType: type,
                        since: new Date(occurredAt.getTime() - windowMs),
                        // Dùng event-time window đối xứng để event đến trễ vẫn ghép được với event đã xử lý trước.
                        // Ledger chống duplicate bảo đảm việc replay không cộng relation lần hai.
                        until: new Date(occurredAt.getTime() + windowMs),
                        types,
                        limit: type === 'CO_VIEW' ? 20 : 50,
                    },
                    manager,
                );
                const claimedRelatedSignals = [] as typeof relatedSignals;
                for (const related of relatedSignals) {
                    if (related.productId === productId) continue;
                    if (
                        await this.repository.claimPair(
                            event.eventId,
                            related.eventId,
                            type,
                            manager,
                        )
                    ) {
                        claimedRelatedSignals.push(related);
                    }
                }
                const relatedProducts = claimedRelatedSignals.map(
                    (related) => related.productId,
                );
                const relations = claimedRelatedSignals.flatMap((related) =>
                    this.buildBothDirections(
                        productId,
                        related.productId,
                        type,
                        occurredAt,
                        weight,
                        related.occurredAt,
                    ),
                );
                // Không gọi persistence với batch rỗng; event đầu tiên trong window thường chưa có pair để ghi.
                if (relations.length > 0) {
                    await this.repository.addRelations(relations, manager);
                }
                await this.repository.pruneSourceRelationsBatch(
                    [productId, ...relatedProducts],
                    type,
                    100,
                    manager,
                );
            },
        );
    }

    // Project only completed purchase event; return event contributes negative correction to same product pairs.
    async projectPurchase(event: RecommendationPurchaseEvent): Promise<void> {
        const type: RelationType = 'CO_PURCHASE';
        const products = [
            ...new Set(event.data.items.map((item) => item.productId)),
        ].slice(0, 50);
        const returned = event.eventName === 'order.purchase.returned';
        const scoreDelta = this.rules.getPurchaseRelationWeight(returned);
        const now = new Date(event.data.occurredAt);
        if (Number.isNaN(now.getTime()))
            throw new Error('INVALID_PURCHASE_OCCURRED_AT');
        await this.repository.withProjection(
            event.eventId,
            type,
            async (manager) => {
                const relations = products.flatMap((source) =>
                    products
                        .filter((target) => target !== source)
                        .map((target) => ({
                            sourceProductId: source,
                            targetProductId: target,
                            relationType: type,
                            positiveDelta: returned ? 0 : 1,
                            negativeDelta: returned ? 1 : 0,
                            scoreDelta,
                            signalAt: now,
                            windowStart: now,
                            windowEnd: now,
                        })),
                );
                await this.repository.addRelations(relations, manager);
                await this.repository.pruneSourceRelationsBatch(
                    products,
                    type,
                    100,
                    manager,
                );
            },
        );
    }

    // Chuyển interaction type thành relation policy; search/impression ngoài nhóm không tạo pair nặng.
    private toRelationType(type: string): RelationType | null {
        if (
            ['PRODUCT_VIEWED', 'PRODUCT_CLICKED', 'PRODUCT_IMPRESSED'].includes(
                type,
            )
        )
            return 'CO_VIEW';
        if (type === 'PRODUCT_ADDED_TO_CART') return 'CO_CART';
        return null;
    }

    // Tạo cả hai chiều để anchor A có thể gợi ý B và anchor B có thể gợi ý A.
    // Persistence sẽ ghi toàn bộ batch trong một statement để tránh N+1 query.
    private buildBothDirections(
        source: string,
        target: string,
        relationType: RelationType,
        signalAt: Date,
        weight: number,
        relatedSignalAt?: Date,
    ) {
        const windowStart = new Date(
            Math.min(
                signalAt.getTime(),
                relatedSignalAt?.getTime() ?? signalAt.getTime(),
            ),
        );
        const windowEnd = new Date(
            Math.max(
                signalAt.getTime(),
                relatedSignalAt?.getTime() ?? signalAt.getTime(),
            ),
        );
        const start = new Date(
            windowStart.getTime() -
                (relationType === 'CO_VIEW'
                    ? 30 * 60_000
                    : 7 * 24 * 60 * 60_000),
        );
        return [
            {
                sourceProductId: source,
                targetProductId: target,
                relationType,
                positiveDelta: 1,
                negativeDelta: 0,
                scoreDelta: weight,
                signalAt: windowEnd,
                windowStart: start,
                windowEnd,
            },
            {
                sourceProductId: target,
                targetProductId: source,
                relationType,
                positiveDelta: 1,
                negativeDelta: 0,
                scoreDelta: weight,
                signalAt: windowEnd,
                windowStart: start,
                windowEnd,
            },
        ];
    }
}
