// Service này chuyển event thành profile signal; transaction và SQL persistence được ủy quyền cho repositories của Profiles domain.

import { Injectable, Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { CatalogService } from '@/modules/catalog/application/services/catalog/catalog.service';
import type { RecommendationActorType } from '@/database/profiles/entities/actor-profile.entity';
import type { RecommendationPreferenceDimension } from '@/database/profiles/entities/actor-preference.entity';
import { RecommendationRedisService } from '@/infrastructure/redis/redis.module';
import type { RecommendationInteractionRecordedEvent } from '@/modules/interactions/application/types/interaction-event.types';
import type { OrderPurchaseEvent } from '@common/kafka/events/order.events';
import { PopularityService } from '@/modules/profiles/application/services/popularity/popularity.service';
import { SessionContextService } from '@/modules/profiles/application/services/session/session-context.service';
import { ProfileProjectionRepository } from '@/modules/profiles/infrastructure/repositories/profile-projection.repository';
import { RecommendationRuleService } from '@/modules/profiles/application/services/rules/recommendation-rule.service';

type ProfileActor = {
    actorType: RecommendationActorType;
    actorId: string;
};

// Application service điều phối profile, catalog context, popularity và cache invalidation nhưng không chứa truy vấn database.
@Injectable()
export class ProfileProjectionService {
    private readonly logger = new Logger(ProfileProjectionService.name);

    constructor(
        private readonly projectionRepository: ProfileProjectionRepository,
        private readonly catalog: CatalogService,
        private readonly sessionContext: SessionContextService,
        private readonly popularity: PopularityService,
        private readonly redis: RecommendationRedisService,
        private readonly rules: RecommendationRuleService,
    ) {}

    // Project interaction một lần trong transaction, sau commit mới cập nhật Redis để cache không vượt qua durable state.
    async project(
        event: RecommendationInteractionRecordedEvent,
    ): Promise<void> {
        const occurredAt = this.parseOccurredAt(event.occurredAt);
        const catalogProduct = await this.findCatalogProduct(
            event.data.productId,
        );
        const categoryId =
            event.data.categoryId ?? catalogProduct?.categoryId ?? null;
        const brandId = catalogProduct?.brandId ?? null;
        const projectionResult = await this.projectionRepository.transaction(
            async (manager) => {
                if (!event.data.userId && event.data.sessionId) {
                    await this.projectionRepository.lockSessionMerge(
                        event.data.sessionId,
                        manager,
                    );
                }
                if (
                    !(await this.projectionRepository.claimProjectionEvent(
                        event.eventId,
                        manager,
                    ))
                ) {
                    return {
                        projected: false,
                        actorUserId: null,
                        shouldUpdateSessionContext: false,
                    };
                }

                const weight = this.rules.getInteractionWeight(
                    event.data.interactionType,
                );
                const actor = await this.resolveInteractionActor(
                    event,
                    manager,
                );
                if (actor) {
                    await this.projectionRepository.upsertActorProfile(
                        actor.actorType,
                        actor.actorId,
                        occurredAt,
                        manager,
                    );
                    await this.applyInteractionPreferences(
                        actor,
                        event,
                        categoryId,
                        brandId,
                        weight,
                        occurredAt,
                        manager,
                    );
                }

                await this.popularity.applyInteraction(event, manager);
                return {
                    projected: true,
                    // Event guest đến sau khi merge đã được chuyển sang USER trong transaction;
                    // trả actor này ra ngoài để invalidation không bỏ sót user cache.
                    actorUserId:
                        actor?.actorType === 'USER' ? actor.actorId : null,
                    // Guest event đến sau merge đã thuộc USER; không dựng lại session context đã bị xóa.
                    shouldUpdateSessionContext: actor?.actorType === 'SESSION',
                };
            },
        );

        if (!projectionResult.projected) return;
        if (projectionResult.shouldUpdateSessionContext) {
            await this.sessionContext.apply(event, categoryId, brandId);
        }
        const userIds = new Set(
            [event.data.userId, projectionResult.actorUserId].filter(
                (value): value is string => Boolean(value),
            ),
        );
        await Promise.all([
            ...[...userIds].map((id) => this.redis.invalidateActor('user', id)),
            event.data.sessionId
                ? this.redis.invalidateActor('session', event.data.sessionId)
                : Promise.resolve(),
        ]);
    }

    // Project purchase/return với weight mạnh hơn browsing và dùng cùng projection ledger để chống duplicate.
    async projectPurchase(event: OrderPurchaseEvent): Promise<void> {
        const occurredAt = this.parseOccurredAt(event.data.occurredAt);
        const weight = this.rules.getPurchaseWeight(event.eventName);
        const projected = await this.projectionRepository.transaction(
            async (manager) => {
                if (
                    !(await this.projectionRepository.claimProjectionEvent(
                        event.eventId,
                        manager,
                    ))
                ) {
                    return false;
                }

                await this.projectionRepository.upsertActorProfile(
                    'USER',
                    event.data.customerUserId,
                    occurredAt,
                    manager,
                );
                for (const item of event.data.items) {
                    await this.upsertPreference(
                        {
                            actorType: 'USER',
                            actorId: event.data.customerUserId,
                            dimension: 'PRODUCT',
                            dimensionKey: item.productId,
                            score: weight * item.quantity,
                            occurredAt,
                        },
                        manager,
                    );
                    await this.upsertPreference(
                        {
                            actorType: 'USER',
                            actorId: event.data.customerUserId,
                            dimension: 'CATEGORY',
                            dimensionKey: item.categoryId,
                            score: weight * item.quantity,
                            occurredAt,
                        },
                        manager,
                    );
                }

                await this.popularity.applyPurchase(event, manager);
                return true;
            },
        );

        if (projected) {
            await this.redis.invalidateActor('user', event.data.customerUserId);
        }
    }

    // Catalog chỉ bổ sung category/brand; nếu read model chậm thì vẫn giữ interaction product/query đã nhận.
    private async findCatalogProduct(productId: string | null) {
        if (!productId) return undefined;
        try {
            return (await this.catalog.findByIds([productId]))[0];
        } catch (error) {
            this.logger.warn(
                `Catalog metadata unavailable for ${productId}: ${error instanceof Error ? error.message : 'unknown error'}`,
            );
            return undefined;
        }
    }

    // Chặn Date Invalid trước transaction để dữ liệu hỏng đi retry/DLQ thay vì làm sai profile chronology.
    private parseOccurredAt(value: string): Date {
        const date = new Date(value);
        if (Number.isNaN(date.getTime()))
            throw new Error('INVALID_OCCURRED_AT');
        return date;
    }

    // Chọn đúng một actor: user đã đăng nhập ưu tiên USER, guest mới dùng SESSION để tránh merge cộng trùng tín hiệu.
    private getInteractionActor(
        event: RecommendationInteractionRecordedEvent,
    ): ProfileActor | null {
        if (event.data.userId)
            return { actorType: 'USER', actorId: event.data.userId };
        if (event.data.sessionId)
            return { actorType: 'SESSION', actorId: event.data.sessionId };
        return null;
    }

    // Chuyển event session đến sau login sang user đã merge để không làm mất tín hiệu đang chờ Kafka projection.
    private async resolveInteractionActor(
        event: RecommendationInteractionRecordedEvent,
        manager: EntityManager,
    ): Promise<ProfileActor | null> {
        if (event.data.userId)
            return { actorType: 'USER', actorId: event.data.userId };
        if (!event.data.sessionId) return null;
        const mergedUserId = await this.projectionRepository.findMergedUserId(
            event.data.sessionId,
            manager,
        );
        return mergedUserId
            ? { actorType: 'USER', actorId: mergedUserId }
            : this.getInteractionActor(event);
    }

    // Chuyển interaction thành các dimension preference và bỏ qua dimension thiếu key hoặc event không có weight.
    private async applyInteractionPreferences(
        actor: ProfileActor,
        event: RecommendationInteractionRecordedEvent,
        categoryId: string | null,
        brandId: string | null,
        weight: number,
        occurredAt: Date,
        manager: EntityManager,
    ): Promise<void> {
        const preferences: Array<{
            dimension: RecommendationPreferenceDimension;
            dimensionKey: string | null;
        }> = [
            { dimension: 'PRODUCT', dimensionKey: event.data.productId },
            { dimension: 'CATEGORY', dimensionKey: categoryId },
            { dimension: 'BRAND', dimensionKey: brandId },
            {
                dimension: 'QUERY',
                dimensionKey: event.data.query?.toLowerCase() ?? null,
            },
        ];

        for (const preference of preferences) {
            await this.upsertPreference(
                {
                    actorType: actor.actorType,
                    actorId: actor.actorId,
                    dimension: preference.dimension,
                    dimensionKey: preference.dimensionKey,
                    score: weight,
                    occurredAt,
                },
                manager,
            );
        }
    }

    // Không ghi preference thiếu dimension key hoặc weight bằng 0 để tránh tạo row không thể dùng cho ranking.
    private async upsertPreference(
        input: {
            actorType: RecommendationActorType;
            actorId: string;
            dimension: RecommendationPreferenceDimension;
            dimensionKey: string | null;
            score: number;
            occurredAt: Date;
        },
        manager: EntityManager,
    ): Promise<void> {
        if (!input.dimensionKey || input.score === 0) return;
        await this.projectionRepository.upsertPreference(
            {
                ...input,
                dimensionKey: input.dimensionKey,
            },
            manager,
        );
    }
}
