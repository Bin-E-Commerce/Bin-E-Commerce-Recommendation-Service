// Application service này tạo envelope từ request đã qua Gateway, xác thực attribution và đưa event vào Kafka.
// Service không tự lưu database; consumer chịu trách nhiệm persistence và projection bất đồng bộ.

import {
    BadRequestException,
    Injectable,
    ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { RecommendationEvents } from '@common/kafka/events/recommendation.events';
import type { RecommendationInteractionType } from '@common/kafka/events/recommendation.events';
import { KafkaProducerService } from '@/kafka/producers/kafka-producer.service';
import { RECOMMENDATION_INTERACTIONS_TOPIC } from '@/kafka/config/kafka.constants';
import type { RecordInteractionDto } from '@/modules/interactions/presentation/dto/record-interaction.dto';
import {
    RecommendationTrackingTokenService,
    type RecommendationTrackingTokenInput,
} from '@/modules/recommendation/application/services/tracking/attribution/recommendation-tracking-token.service';

type RecommendationAttribution = {
    recommendationRequestId: string | null;
    recommendationItemId: string | null;
    recommendationSource: string | null;
    recommendationRank: number | null;
    surface: RecommendationTrackingTokenInput['surface'] | null;
    recommendationPolicyVersion: string | null;
    recommendationRankingMode: 'HYBRID' | 'ML_HYBRID' | null;
};

type TrustedActor = {
    userId: string | null;
    sessionId: string | null;
    actorId: string;
};

@Injectable()
export class InteractionIngestionService {
    // Producer là boundary duy nhất để HTTP request trở thành durable event.
    constructor(
        private readonly kafkaProducer: KafkaProducerService,
        private readonly trackingToken: RecommendationTrackingTokenService,
    ) {}

    // Tạo một event accepted với actor từ trusted Gateway headers và trả eventId để client có thể đối chiếu.
    async record(
        dto: RecordInteractionDto,
        request: Request,
    ): Promise<{ eventId: string }> {
        const actor = this.getActor(request);
        const event = this.createEvent(dto, request, actor);

        try {
            await this.kafkaProducer.publish(
                RECOMMENDATION_INTERACTIONS_TOPIC,
                actor.actorId,
                event,
            );
        } catch {
            throw new ServiceUnavailableException(
                'Recommendation event queue is temporarily unavailable',
            );
        }

        return { eventId: event.eventId };
    }

    // Tạo toàn bộ envelope trước khi publish để nếu một event invalid thì không phát một phần batch.
    // Một Kafka request được dùng cho cả batch, giảm network round-trip khi người dùng scroll qua nhiều card.
    async recordMany(
        dtos: RecordInteractionDto[],
        request: Request,
    ): Promise<{ eventIds: string[] }> {
        if (dtos.length === 0 || dtos.length > 50) {
            throw new BadRequestException(
                'Interaction batch must contain 1-50 events',
            );
        }

        const actor = this.getActor(request);
        const events = dtos.map((dto) => this.createEvent(dto, request, actor));

        try {
            await this.kafkaProducer.publishBatch(
                RECOMMENDATION_INTERACTIONS_TOPIC,
                events.map((event) => ({ key: actor.actorId, payload: event })),
            );
        } catch {
            throw new ServiceUnavailableException(
                'Recommendation event queue is temporarily unavailable',
            );
        }

        return { eventIds: events.map((event) => event.eventId) };
    }

    // Lấy identity từ trusted headers một lần cho cả request; client không được truyền userId trong body.
    private getActor(request: Request): TrustedActor {
        const userId = this.getHeader(request, 'x-user-id');
        const sessionId = this.getHeader(request, 'x-session-id');
        const actorId = userId ?? sessionId;

        if (!actorId || (!userId && !this.isUuidV4(sessionId))) {
            throw new BadRequestException(
                'A valid user or guest session is required',
            );
        }

        return { userId, sessionId, actorId };
    }

    // Chuẩn hóa DTO thành envelope Kafka; server tự cấp eventId và occurredAt để bảo vệ thứ tự, decay và deduplication.
    private createEvent(
        dto: RecordInteractionDto,
        request: Request,
        actor: TrustedActor,
    ) {
        const attribution = this.validateRecommendationAttribution(
            dto,
            actor.actorId,
        );
        const eventId = randomUUID();

        // Timestamp của server là nguồn tin cậy; không dùng thời gian từ browser để client không làm sai profile hoặc relation window.
        return {
            eventId,
            eventName: RecommendationEvents.INTERACTION_RECORDED,
            eventVersion: 1,
            source: 'api-gateway',
            occurredAt: new Date().toISOString(),
            aggregateId: actor.actorId,
            metadata: this.getMetadata(request, actor.userId),
            data: {
                interactionType:
                    dto.interactionType as RecommendationInteractionType,
                userId: actor.userId,
                sessionId: actor.sessionId,
                productId: dto.productId?.trim() || null,
                variantId: dto.variantId?.trim() || null,
                categoryId: dto.categoryId?.trim() || null,
                query: dto.query?.trim() || null,
                page: dto.page?.trim() || null,
                position: dto.position ?? null,
                quantity: dto.quantity ?? null,
                requestId: this.getHeader(request, 'x-request-id'),
                recommendationRequestId: attribution.recommendationRequestId,
                recommendationItemId: attribution.recommendationItemId,
                recommendationSource: attribution.recommendationSource,
                recommendationRank: attribution.recommendationRank,
                surface: attribution.surface,
                recommendationPolicyVersion:
                    attribution.recommendationPolicyVersion,
                recommendationRankingMode:
                    attribution.recommendationRankingMode,
            },
        };
    }

    // Chỉ lấy header scalar và bỏ qua array để tránh tạo event không xác định từ request giả mạo.
    private getHeader(request: Request, name: string): string | null {
        const value = request.headers[name];
        return typeof value === 'string' && value.trim() ? value.trim() : null;
    }

    // Guest identity phải là UUID v4 để client không gửi chuỗi tùy ý làm partition key hoặc dữ liệu định danh.
    private isUuidV4(value: string | null): boolean {
        return value
            ? /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                  value,
              )
            : false;
    }

    // Chỉ chấp nhận attribution do Recommendation Service ký; ranking mode tự khai từ browser không được đi vào analytics.
    private validateRecommendationAttribution(
        dto: RecordInteractionDto,
        actorId: string,
    ): RecommendationAttribution {
        const recommendationRequestId =
            dto.recommendationRequestId?.trim() || null;
        const recommendationItemId = dto.recommendationItemId?.trim() || null;
        const recommendationSource = dto.recommendationSource?.trim() || null;
        const recommendationPolicyVersion =
            dto.recommendationPolicyVersion?.trim() || null;
        const recommendationRankingMode = dto.recommendationRankingMode ?? null;
        const hasAnyAttribution = Boolean(
            recommendationRequestId ||
            recommendationItemId ||
            recommendationSource ||
            dto.recommendationRank !== undefined ||
            dto.surface ||
            recommendationPolicyVersion ||
            recommendationRankingMode,
        );

        if (!recommendationRequestId) {
            if (hasAnyAttribution) {
                throw new BadRequestException(
                    'Recommendation attribution requires a signed item token',
                );
            }
            return {
                recommendationRequestId: null,
                recommendationItemId: null,
                recommendationSource: null,
                recommendationRank: null,
                surface: null,
                recommendationPolicyVersion: null,
                recommendationRankingMode: null,
            };
        }

        const recommendationRank = dto.recommendationRank ?? null;
        const surface = dto.surface ?? null;
        if (
            !recommendationItemId ||
            !recommendationSource ||
            recommendationRank === null ||
            !surface ||
            !['home', 'product_detail', 'recommendations_page'].includes(
                surface,
            ) ||
            !recommendationPolicyVersion ||
            !dto.productId?.trim()
        ) {
            throw new BadRequestException(
                'Incomplete recommendation attribution context',
            );
        }

        const isValid = this.trackingToken.verify(recommendationItemId, {
            actorId,
            requestId: recommendationRequestId,
            productId: dto.productId?.trim() ?? '',
            rank: recommendationRank,
            source: recommendationSource,
            surface,
            policyVersion: recommendationPolicyVersion,
            rankingMode: recommendationRankingMode as 'HYBRID' | 'ML_HYBRID',
        });
        if (!isValid) {
            throw new BadRequestException('Invalid recommendation attribution');
        }

        return {
            recommendationRequestId,
            recommendationItemId,
            recommendationSource,
            recommendationRank,
            surface,
            recommendationPolicyVersion,
            recommendationRankingMode,
        };
    }

    // Metadata chỉ phục vụ correlation; không forward toàn bộ headers hoặc dữ liệu nhạy cảm vào Kafka.
    private getMetadata(request: Request, userId: string | null) {
        const correlationId = this.getHeader(request, 'x-request-id');
        const metadata: { correlationId?: string; actorUserId?: string } = {};
        if (correlationId) metadata.correlationId = correlationId;
        if (userId) metadata.actorUserId = userId;
        return metadata;
    }
}
