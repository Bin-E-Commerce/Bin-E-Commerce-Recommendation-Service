// Application service này tạo envelope từ request đã qua Gateway, không cho client tự giả mạo userId.

import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { RecommendationEvents } from "../../../../../../../../packages/common/kafka/events/recommendation.events";
import type { RecommendationInteractionType } from "../../../../../../../../packages/common/kafka/events/recommendation.events";
import { KafkaProducerService } from "../../../../../kafka/producers/kafka-producer.service";
import { RECOMMENDATION_INTERACTIONS_TOPIC } from "../../../../../kafka/config/kafka.constants";
import type { RecordInteractionDto } from "../../../presentation/dto/record-interaction.dto";
import {
  RecommendationTrackingTokenService,
  type RecommendationTrackingTokenInput,
} from "../../../../recommendation/application/services/tracking/attribution/recommendation-tracking-token.service";

type RecommendationAttribution = {
  recommendationRequestId: string | null;
  recommendationItemId: string | null;
  recommendationSource: string | null;
  recommendationRank: number | null;
  surface: RecommendationTrackingTokenInput["surface"] | null;
  recommendationPolicyVersion: string | null;
  recommendationExperimentId: string | null;
  recommendationExperimentVariant: "CONTROL" | "HYBRID" | null;
};

@Injectable()
export class InteractionIngestionService {
  // Producer là boundary duy nhất để HTTP request trở thành durable event.
  constructor(
    private readonly kafkaProducer: KafkaProducerService,
    private readonly trackingToken: RecommendationTrackingTokenService,
  ) {}

  // Tạo event accepted với actor từ trusted Gateway headers và trả eventId để trace request.
  async record(
    dto: RecordInteractionDto,
    request: Request,
  ): Promise<{ eventId: string }> {
    const userId = this.getHeader(request, "x-user-id");
    const sessionId = this.getHeader(request, "x-session-id");
    const actorId = userId ?? sessionId;

    if (!actorId || (!userId && !this.isUuidV4(sessionId))) {
      throw new BadRequestException(
        "A valid user or guest session is required",
      );
    }

    const attribution = this.validateRecommendationAttribution(dto, actorId);
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
        recommendationRequestId: attribution.recommendationRequestId,
        recommendationItemId: attribution.recommendationItemId,
        recommendationSource: attribution.recommendationSource,
        recommendationRank: attribution.recommendationRank,
        surface: attribution.surface,
        recommendationPolicyVersion: attribution.recommendationPolicyVersion,
        recommendationExperimentId: attribution.recommendationExperimentId,
        recommendationExperimentVariant:
          attribution.recommendationExperimentVariant,
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
      ? /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          value,
        )
      : false;
  }

  // Chỉ chấp nhận attribution do Recommendation Service ký; metadata tự khai từ browser không được đi vào A/B metrics.
  private validateRecommendationAttribution(
    dto: RecordInteractionDto,
    actorId: string,
  ): RecommendationAttribution {
    const recommendationRequestId = dto.recommendationRequestId?.trim() || null;
    const recommendationItemId = dto.recommendationItemId?.trim() || null;
    const recommendationSource = dto.recommendationSource?.trim() || null;
    const recommendationPolicyVersion =
      dto.recommendationPolicyVersion?.trim() || null;
    const recommendationExperimentId =
      dto.recommendationExperimentId?.trim() || null;
    const recommendationExperimentVariant =
      dto.recommendationExperimentVariant ?? null;
    const hasAnyAttribution = Boolean(
      recommendationRequestId ||
      recommendationItemId ||
      recommendationSource ||
      dto.recommendationRank !== undefined ||
      dto.surface ||
      recommendationPolicyVersion ||
      recommendationExperimentId ||
      recommendationExperimentVariant,
    );

    if (!recommendationRequestId) {
      if (hasAnyAttribution) {
        throw new BadRequestException(
          "Recommendation attribution requires a signed item token",
        );
      }
      return {
        recommendationRequestId: null,
        recommendationItemId: null,
        recommendationSource: null,
        recommendationRank: null,
        surface: null,
        recommendationPolicyVersion: null,
        recommendationExperimentId: null,
        recommendationExperimentVariant: null,
      };
    }

    const recommendationRank = dto.recommendationRank ?? null;
    const surface = dto.surface ?? null;
    if (
      !recommendationItemId ||
      !recommendationSource ||
      recommendationRank === null ||
      !surface ||
      !["home", "product_detail", "recommendations_page"].includes(surface) ||
      !recommendationPolicyVersion ||
      !dto.productId?.trim()
    ) {
      throw new BadRequestException(
        "Incomplete recommendation attribution context",
      );
    }

    const isValid = this.trackingToken.verify(recommendationItemId, {
      actorId,
      requestId: recommendationRequestId,
      productId: dto.productId?.trim() ?? "",
      rank: recommendationRank,
      source: recommendationSource,
      surface,
      policyVersion: recommendationPolicyVersion,
      experimentId: recommendationExperimentId,
      experimentVariant: recommendationExperimentVariant,
    });
    if (!isValid) {
      throw new BadRequestException("Invalid recommendation attribution");
    }

    return {
      recommendationRequestId,
      recommendationItemId,
      recommendationSource,
      recommendationRank,
      surface,
      recommendationPolicyVersion,
      recommendationExperimentId,
      recommendationExperimentVariant,
    };
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
