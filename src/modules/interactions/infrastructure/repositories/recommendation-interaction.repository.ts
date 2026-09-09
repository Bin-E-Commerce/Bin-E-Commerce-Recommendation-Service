// Repository này là adapter duy nhất ghi interaction vào PostgreSQL và biến unique event thành kết quả duplicate an toàn.

import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import type { RecommendationInteractionRecordedEvent } from "../../application/types/interaction-event.types";
import { RecommendationInteractionEntity } from "../../../../database/interactions/entities/interaction.entity";
import { Repository } from "typeorm";

export type InteractionInsertResult = "inserted" | "duplicate";

@Injectable()
export class RecommendationInteractionRepository {
  // Nhận repository TypeORM qua DI để application không phụ thuộc ORM trực tiếp.
  constructor(
    @InjectRepository(RecommendationInteractionEntity)
    private readonly repository: Repository<RecommendationInteractionEntity>,
  ) {}

  // Ghi interaction một lần; unique event_id là lớp bảo vệ cuối cùng cho Kafka redelivery.
  async insertIfNotExists(
    event: RecommendationInteractionRecordedEvent,
  ): Promise<InteractionInsertResult> {
    const entity = this.repository.create({
      eventId: event.eventId,
      eventName: event.eventName,
      eventVersion: event.eventVersion,
      source: event.source,
      occurredAt: new Date(event.occurredAt),
      userId: event.data.userId,
      sessionId: event.data.sessionId,
      interactionType: event.data.interactionType,
      productId: event.data.productId,
      variantId: event.data.variantId,
      categoryId: event.data.categoryId,
      query: event.data.query,
      page: event.data.page,
      position: event.data.position,
      quantity: event.data.quantity,
      requestId: event.data.requestId,
      recommendationRequestId: event.data.recommendationRequestId ?? null,
      recommendationItemId: event.data.recommendationItemId ?? null,
      recommendationSource: event.data.recommendationSource ?? null,
      recommendationRank: event.data.recommendationRank ?? null,
      surface: event.data.surface ?? null,
      recommendationPolicyVersion:
        event.data.recommendationPolicyVersion ?? null,
      recommendationExperimentId: event.data.recommendationExperimentId ?? null,
      recommendationExperimentVariant:
        event.data.recommendationExperimentVariant ?? null,
      metadata: { ...(event.metadata ?? {}) },
      processingStatus: "PROCESSED",
      processingError: null,
      processedAt: new Date(),
    });

    try {
      await this.repository.insert(entity);
      return "inserted";
    } catch (error) {
      if (this.isUniqueViolation(error)) return "duplicate";
      throw error;
    }
  }

  // Chỉ nuốt lỗi unique event_id; mọi lỗi database khác phải retry và cuối cùng vào DLQ.
  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "23505"
    );
  }
}
