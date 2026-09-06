// Service này chuyển event thành profile signal; transaction và SQL persistence được ủy quyền cho repositories của Profiles domain.

import { Injectable } from "@nestjs/common";
import type { EntityManager } from "typeorm";
import { CatalogService } from "../../../../catalog/application/services/catalog.service";
import type { RecommendationActorType } from "../../../../../database/profiles/entities/actor-profile.entity";
import type { RecommendationPreferenceDimension } from "../../../../../database/profiles/entities/actor-preference.entity";
import { RecommendationRedisService } from "../../../../../infrastructure/redis/redis.module";
import type { RecommendationInteractionRecordedEvent } from "../../../../interactions/application/types/interaction-event.types";
import type { OrderPurchaseEvent } from "@common/kafka/events/order.events";
import { PopularityService } from "../popularity/popularity.service";
import { SessionContextService } from "../session/session-context.service";
import { ProfileProjectionRepository } from "../../../infrastructure/repositories/profile-projection.repository";
import { RecommendationRuleService } from "../rules/recommendation-rule.service";

type ProfileActor = {
  actorType: RecommendationActorType;
  actorId: string;
};

// Application service điều phối profile, catalog context, popularity và cache invalidation nhưng không chứa truy vấn database.
@Injectable()
export class ProfileProjectionService {
  constructor(
    private readonly projectionRepository: ProfileProjectionRepository,
    private readonly catalog: CatalogService,
    private readonly sessionContext: SessionContextService,
    private readonly popularity: PopularityService,
    private readonly redis: RecommendationRedisService,
    private readonly rules: RecommendationRuleService,
  ) {}

  // Project interaction một lần trong transaction, sau commit mới cập nhật Redis để cache không vượt qua durable state.
  async project(event: RecommendationInteractionRecordedEvent): Promise<void> {
    const catalogProduct = event.data.productId
      ? (await this.catalog.findByIds([event.data.productId]))[0]
      : undefined;
    const categoryId = event.data.categoryId ?? catalogProduct?.categoryId ?? null;
    const brandId = catalogProduct?.brandId ?? null;
    const projected = await this.projectionRepository.transaction(async (manager) => {
      if (!(await this.projectionRepository.claimProjectionEvent(event.eventId, manager))) {
        return false;
      }

      const weight = this.rules.getInteractionWeight(event.data.interactionType);
      const actor = this.getInteractionActor(event);
      if (actor) {
        await this.projectionRepository.upsertActorProfile(
          actor.actorType,
          actor.actorId,
          new Date(event.occurredAt),
          manager,
        );
        await this.applyInteractionPreferences(
          actor,
          event,
          categoryId,
          brandId,
          weight,
          manager,
        );
      }

      await this.popularity.applyInteraction(event, manager);
      return true;
    });

    if (!projected) return;
    await this.sessionContext.apply(event, categoryId, brandId);
    await Promise.all([
      event.data.userId
        ? this.redis.invalidateActor("user", event.data.userId)
        : Promise.resolve(),
      event.data.sessionId
        ? this.redis.invalidateActor("session", event.data.sessionId)
        : Promise.resolve(),
    ]);
  }

  // Project purchase/return với weight mạnh hơn browsing và dùng cùng projection ledger để chống duplicate.
  async projectPurchase(event: OrderPurchaseEvent): Promise<void> {
    const weight = event.eventName === "order.purchase.returned" ? -8 : 8;
    const projected = await this.projectionRepository.transaction(async (manager) => {
      if (!(await this.projectionRepository.claimProjectionEvent(event.eventId, manager))) {
        return false;
      }

      await this.projectionRepository.upsertActorProfile(
        "USER",
        event.data.customerUserId,
        new Date(event.data.occurredAt),
        manager,
      );
      for (const item of event.data.items) {
        await this.upsertPreference(
          {
            actorType: "USER",
            actorId: event.data.customerUserId,
            dimension: "PRODUCT",
            dimensionKey: item.productId,
            score: weight * item.quantity,
            occurredAt: new Date(event.data.occurredAt),
          },
          manager,
        );
        await this.upsertPreference(
          {
            actorType: "USER",
            actorId: event.data.customerUserId,
            dimension: "CATEGORY",
            dimensionKey: item.categoryId,
            score: weight * item.quantity,
            occurredAt: new Date(event.data.occurredAt),
          },
          manager,
        );
      }

      await this.popularity.applyPurchase(event, manager);
      return true;
    });

    if (projected) {
      await this.redis.invalidateActor("user", event.data.customerUserId);
    }
  }

  // Chọn đúng một actor: user đã đăng nhập ưu tiên USER, guest mới dùng SESSION để tránh merge cộng trùng tín hiệu.
  private getInteractionActor(
    event: RecommendationInteractionRecordedEvent,
  ): ProfileActor | null {
    if (event.data.userId) return { actorType: "USER", actorId: event.data.userId };
    if (event.data.sessionId) return { actorType: "SESSION", actorId: event.data.sessionId };
    return null;
  }

  // Chuyển interaction thành các dimension preference và bỏ qua dimension thiếu key hoặc event không có weight.
  private async applyInteractionPreferences(
    actor: ProfileActor,
    event: RecommendationInteractionRecordedEvent,
    categoryId: string | null,
    brandId: string | null,
    weight: number,
    manager: EntityManager,
  ): Promise<void> {
    const preferences: Array<{
      dimension: RecommendationPreferenceDimension;
      dimensionKey: string | null;
    }> = [
      { dimension: "PRODUCT", dimensionKey: event.data.productId },
      { dimension: "CATEGORY", dimensionKey: categoryId },
      { dimension: "BRAND", dimensionKey: brandId },
      { dimension: "QUERY", dimensionKey: event.data.query?.toLowerCase() ?? null },
    ];

    for (const preference of preferences) {
      await this.upsertPreference(
        {
          actorType: actor.actorType,
          actorId: actor.actorId,
          dimension: preference.dimension,
          dimensionKey: preference.dimensionKey,
          score: weight,
          occurredAt: new Date(event.occurredAt),
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
