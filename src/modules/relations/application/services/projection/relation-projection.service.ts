import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { EntityManager } from "typeorm";
import type { RecommendationInteractionRecordedEvent } from "@common/kafka/events/recommendation.events";
import type { RecommendationPurchaseEvent } from "@common/kafka/events/recommendation.events";
import {
  RelationRepository,
  type RelationType,
} from "../../../infrastructure/repositories/relation.repository";

// Application policy cho co-view/co-cart/co-purchase; consumer chỉ parse event rồi ủy quyền logic tại đây.
@Injectable()
export class RelationProjectionService {
  constructor(
    private readonly repository: RelationRepository,
    private readonly config: ConfigService,
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
      throw new Error("INVALID_INTERACTION_OCCURRED_AT");
    const windowMs = type === "CO_VIEW" ? 30 * 60_000 : 7 * 24 * 60 * 60_000;
    const types =
      type === "CO_VIEW"
        ? ["PRODUCT_VIEWED", "PRODUCT_CLICKED", "PRODUCT_IMPRESSED"]
        : ["PRODUCT_ADDED_TO_CART"];
    const configuredWeight =
      event.data.interactionType === "PRODUCT_CLICKED"
        ? Number(this.config.get<string>("RELATION_CO_CLICK_WEIGHT", "2"))
        : event.data.interactionType === "PRODUCT_IMPRESSED"
          ? Number(
              this.config.get<string>("RELATION_CO_IMPRESSION_WEIGHT", "0.05"),
            )
          : type === "CO_VIEW"
            ? Number(this.config.get<string>("RELATION_CO_VIEW_WEIGHT", "1"))
            : Number(this.config.get<string>("RELATION_CO_CART_WEIGHT", "3"));
    const weight =
      Number.isFinite(configuredWeight) && configuredWeight > 0
        ? configuredWeight
        : type === "CO_CART"
          ? 3
          : event.data.interactionType === "PRODUCT_IMPRESSED"
            ? 0.05
            : event.data.interactionType === "PRODUCT_CLICKED"
              ? 2
              : 1;
    await this.repository.withProjection(
      event.eventId,
      type,
      async (manager) => {
        const related = await this.repository.findRecentProductIds(
          {
            userId: event.data.userId,
            sessionId: event.data.sessionId,
            since: new Date(occurredAt.getTime() - windowMs),
            types,
            limit: type === "CO_VIEW" ? 20 : 50,
          },
          manager,
        );
        const touchedSources = new Set<string>();
        for (const target of related.filter((item) => item !== productId)) {
          await this.addBothDirections(
            productId,
            target,
            type,
            occurredAt,
            weight,
            manager,
          );
          touchedSources.add(productId);
          touchedSources.add(target);
        }
        for (const sourceProductId of touchedSources)
          await this.repository.pruneSourceRelations(
            sourceProductId,
            type,
            100,
            manager,
          );
      },
    );
  }

  // Project only completed purchase event; return event contributes negative correction to same product pairs.
  async projectPurchase(event: RecommendationPurchaseEvent): Promise<void> {
    const type: RelationType = "CO_PURCHASE";
    const products = [
      ...new Set(event.data.items.map((item) => item.productId)),
    ].slice(0, 50);
    const returned = event.eventName === "order.purchase.returned";
    const configuredScore = Number(
      this.config.get<string>("RELATION_CO_PURCHASE_WEIGHT", "6"),
    );
    const score =
      Number.isFinite(configuredScore) && configuredScore > 0
        ? configuredScore
        : 6;
    const now = new Date(event.data.occurredAt);
    if (Number.isNaN(now.getTime()))
      throw new Error("INVALID_PURCHASE_OCCURRED_AT");
    await this.repository.withProjection(
      event.eventId,
      type,
      async (manager) => {
        for (const source of products)
          for (const target of products)
            if (source !== target)
              await this.repository.addRelation(
                {
                  sourceProductId: source,
                  targetProductId: target,
                  relationType: type,
                  positiveDelta: returned ? 0 : 1,
                  negativeDelta: returned ? 1 : 0,
                  scoreDelta: returned ? -score : score,
                  signalAt: now,
                  windowStart: now,
                  windowEnd: now,
                },
                manager,
              );
        for (const source of products)
          await this.repository.pruneSourceRelations(
            source,
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
      ["PRODUCT_VIEWED", "PRODUCT_CLICKED", "PRODUCT_IMPRESSED"].includes(type)
    )
      return "CO_VIEW";
    if (type === "PRODUCT_ADDED_TO_CART") return "CO_CART";
    return null;
  }

  // Ghi cả hai chiều để anchor A có thể gợi ý B và anchor B có thể gợi ý A.
  private async addBothDirections(
    source: string,
    target: string,
    relationType: RelationType,
    signalAt: Date,
    weight: number,
    manager: EntityManager,
  ): Promise<void> {
    const start = new Date(
      signalAt.getTime() -
        (relationType === "CO_VIEW" ? 30 * 60_000 : 7 * 24 * 60 * 60_000),
    );
    await this.repository.addRelation(
      {
        sourceProductId: source,
        targetProductId: target,
        relationType,
        positiveDelta: 1,
        negativeDelta: 0,
        scoreDelta: weight,
        signalAt,
        windowStart: start,
        windowEnd: signalAt,
      },
      manager,
    );
    await this.repository.addRelation(
      {
        sourceProductId: target,
        targetProductId: source,
        relationType,
        positiveDelta: 1,
        negativeDelta: 0,
        scoreDelta: weight,
        signalAt,
        windowStart: start,
        windowEnd: signalAt,
      },
      manager,
    );
  }
}
