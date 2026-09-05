// Application service này tạo envelope từ request đã qua Gateway, không cho client tự giả mạo userId.

import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Request } from "express";
import {
  RecommendationEvents,
} from "../../../../../../../packages/common/kafka/events/recommendation.events";
import type { RecommendationInteractionType } from "../../../../../../../packages/common/kafka/events/recommendation.events";
import { KafkaProducerService } from "../../../../kafka/producers/kafka-producer.service";
import { RECOMMENDATION_INTERACTIONS_TOPIC } from "../../../../kafka/kafka.constants";
import type { RecordInteractionDto } from "../../presentation/dto/record-interaction.dto";

@Injectable()
export class InteractionIngestionService {
  // Producer là boundary duy nhất để HTTP request trở thành durable event.
  constructor(private readonly kafkaProducer: KafkaProducerService) {}

  // Tạo event accepted với actor từ trusted Gateway headers và trả eventId để trace request.
  async record(dto: RecordInteractionDto, request: Request): Promise<{ eventId: string }> {
    const userId = this.getHeader(request, "x-user-id");
    const sessionId = this.getHeader(request, "x-session-id");
    const actorId = userId ?? sessionId;

    if (!actorId || (!userId && !this.isUuidV4(sessionId))) {
      throw new BadRequestException("A valid user or guest session is required");
    }

    const eventId = randomUUID();
    const event = {
      eventId,
      eventName: RecommendationEvents.INTERACTION_RECORDED,
      eventVersion: 1,
      source: "api-gateway",
      occurredAt: dto.occurredAt ?? new Date().toISOString(),
      aggregateId: actorId,
      metadata: this.getMetadata(request, userId),
      data: {
        interactionType: dto.interactionType as RecommendationInteractionType,
        userId,
        sessionId,
        productId: dto.productId?.trim() || null,
        variantId: dto.variantId?.trim() || null,
        categoryId: dto.categoryId?.trim() || null,
        query: dto.query?.trim() || null,
        page: dto.page?.trim() || null,
        position: dto.position ?? null,
        quantity: dto.quantity ?? null,
        requestId: this.getHeader(request, "x-request-id"),
      },
    };

    try {
      await this.kafkaProducer.publish(
        RECOMMENDATION_INTERACTIONS_TOPIC,
        actorId,
        event,
      );
    } catch {
      throw new ServiceUnavailableException(
        "Recommendation event queue is temporarily unavailable",
      );
    }

    return { eventId };
  }

  // Chỉ lấy header scalar và bỏ qua array để tránh tạo event không xác định.
  private getHeader(request: Request, name: string): string | null {
    const value = request.headers[name];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  // Guest identity phải là UUID v4 để client không gửi chuỗi tùy ý làm partition key hoặc dữ liệu định danh.
  private isUuidV4(value: string | null): boolean {
    return value
      ? /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
      : false;
  }

  // Metadata chỉ phục vụ trace; không forward toàn bộ headers hoặc dữ liệu nhạy cảm vào Kafka.
  private getMetadata(request: Request, userId: string | null) {
    const correlationId = this.getHeader(request, "x-request-id");
    const metadata: { correlationId?: string; actorUserId?: string } = {};
    if (correlationId) metadata.correlationId = correlationId;
    if (userId) metadata.actorUserId = userId;
    return metadata;
  }
}
