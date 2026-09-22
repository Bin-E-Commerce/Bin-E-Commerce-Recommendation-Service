import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Consumer, Kafka } from "kafkajs";
import type {
  RecommendationInteractionRecordedEvent,
  RecommendationPurchaseEvent,
} from "@common/kafka/events/recommendation.events";
import { RecommendationEvents } from "@common/kafka/events/recommendation.events";
import {
  DEFAULT_KAFKA_RETRY_ATTEMPTS,
  DEFAULT_KAFKA_RETRY_BASE_DELAY_MS,
  DEFAULT_KAFKA_RETRY_MAX_DELAY_MS,
  getKafkaRetryDelayMs,
  getNextKafkaOffset,
  RECOMMENDATION_INTERACTIONS_TOPIC,
  RECOMMENDATION_PURCHASE_TOPICS,
  RECOMMENDATION_RELATION_DLQ_TOPIC,
  RECOMMENDATION_RELATION_GROUP,
} from "../../config/kafka.constants";
import { RelationProjectionService } from "../../../modules/relations/application/services/projection/relation-projection.service";
import { KafkaProducerService } from "../../producers/kafka-producer.service";
import { validateInteractionEvent } from "../../../modules/interactions/application/utils/interaction-event.validator";
import { validatePurchaseEvent } from "../validators/event.validators";

// Consumer group riêng cho relation pair generation; query nặng không block profile interaction consumer.
@Injectable()
export class RelationConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RelationConsumerService.name);
  private readonly consumer: Consumer;
  private started = false;
  private stopping = false;
  private restartTimer?: NodeJS.Timeout;

  constructor(
    private readonly config: ConfigService,
    private readonly projection: RelationProjectionService,
    private readonly producer: KafkaProducerService,
  ) {
    const brokers = config
      .get<string>("KAFKA_BROKERS", "localhost:29092")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    this.consumer = new Kafka({
      clientId: "recommendation-relation-consumer",
      brokers,
    }).consumer({
      groupId: RECOMMENDATION_RELATION_GROUP,
      allowAutoTopicCreation: false,
    });
  }

  onModuleInit(): void {
    this.stopping = false;
    void this.start();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.started) await this.consumer.disconnect();
  }

  // Consume interaction/purchase riêng và giữ offset khi database relation lỗi để message được redeliver.
  private async start(): Promise<void> {
    try {
      await this.consumer.connect();
      for (const topic of [
        RECOMMENDATION_INTERACTIONS_TOPIC,
        ...RECOMMENDATION_PURCHASE_TOPICS,
      ])
        await this.consumer.subscribe({ topic, fromBeginning: false });
      this.started = true;
      await this.consumer.run({
        autoCommit: false,
        eachMessage: async ({ topic, partition, message }) => {
          const raw = message.value?.toString() ?? "";
          let event:
            | RecommendationInteractionRecordedEvent
            | RecommendationPurchaseEvent;
          try {
            const parsed = JSON.parse(raw) as unknown;
            event =
              topic === RECOMMENDATION_INTERACTIONS_TOPIC
                ? validateInteractionEvent(parsed)
                : validatePurchaseEvent(parsed);
          } catch {
            await this.producer.publish(
              RECOMMENDATION_RELATION_DLQ_TOPIC,
              message.key?.toString() ??
                `relation-invalid:${partition}:${message.offset}`,
              {
                eventVersion: 1,
                eventId: `dlq:relations:${topic}:${partition}:${message.offset}`,
                eventName: "recommendation.processing.failed",
                failedAt: new Date().toISOString(),
                sourceTopic: topic,
                reason: "INVALID_RELATION_EVENT",
                raw: raw.slice(0, 2000),
              },
            );
            await this.consumer.commitOffsets([
              { topic, partition, offset: getNextKafkaOffset(message.offset) },
            ]);
            return;
          }
          // Lỗi database tạm thời được retry có giới hạn; lỗi bền vững phải vào DLQ,
          // nếu không consumer sẽ giữ một poison message và restart vô hạn ở cùng offset.
          await this.projectWithRetry(topic, event, async () => {
            if (
              topic === RECOMMENDATION_INTERACTIONS_TOPIC &&
              event.eventName === RecommendationEvents.INTERACTION_RECORDED
            ) {
              await this.projection.projectInteraction(
                event as RecommendationInteractionRecordedEvent,
              );
            }
            if (
              (RECOMMENDATION_PURCHASE_TOPICS as readonly string[]).includes(
                topic,
              )
            ) {
              await this.projection.projectPurchase(
                event as unknown as RecommendationPurchaseEvent,
              );
            }
          });
          await this.consumer.commitOffsets([
            { topic, partition, offset: getNextKafkaOffset(message.offset) },
          ]);
        },
      });
    } catch (error) {
      this.logger.warn(
        `Relation consumer unavailable: ${error instanceof Error ? error.message : "unknown"}`,
      );
      if (this.started) await this.consumer.disconnect().catch(() => undefined);
      this.started = false;
      if (!this.stopping) {
        this.restartTimer = setTimeout(() => {
          this.restartTimer = undefined;
          void this.start();
        }, 5000);
      }
    }
  }

  // Chạy projection tối đa vài lần rồi chuyển event lỗi sang DLQ; nếu publish DLQ thất bại thì không commit offset để Kafka retry lại.
  private async projectWithRetry(
    topic: string,
    event: RecommendationInteractionRecordedEvent | RecommendationPurchaseEvent,
    project: () => Promise<void>,
  ): Promise<void> {
    const maxAttempts = this.getPositiveConfig(
      "KAFKA_RELATION_RETRY_ATTEMPTS",
      DEFAULT_KAFKA_RETRY_ATTEMPTS,
      1,
      10,
    );
    const baseDelayMs = this.getPositiveConfig(
      "KAFKA_RELATION_RETRY_BASE_DELAY_MS",
      DEFAULT_KAFKA_RETRY_BASE_DELAY_MS,
      0,
      60_000,
    );
    const maxDelayMs = this.getPositiveConfig(
      "KAFKA_RELATION_RETRY_MAX_DELAY_MS",
      DEFAULT_KAFKA_RETRY_MAX_DELAY_MS,
      0,
      300_000,
    );

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await project();
        return;
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : "RELATION_PROJECTION_FAILED";
        if (attempt === maxAttempts) {
          await this.producer.publish(
            RECOMMENDATION_RELATION_DLQ_TOPIC,
            event.eventId,
            {
              eventVersion: 1,
              eventId: `dlq:relations:${topic}:${event.eventId}`,
              eventName: "recommendation.relation_projection_failed",
              failedAt: new Date().toISOString(),
              sourceTopic: topic,
              reason: reason.slice(0, 500),
              originalEvent: event,
            },
          );
          this.logger.error(
            `Relation event moved to DLQ: ${event.eventId} (${reason})`,
          );
          return;
        }
        this.logger.warn(
          `Relation projection retry ${attempt}/${maxAttempts} for ${event.eventId}: ${reason}`,
        );
        const delayMs = getKafkaRetryDelayMs(
          attempt,
          baseDelayMs,
          Math.max(baseDelayMs, maxDelayMs),
        );
        if (delayMs > 0)
          await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  // Chặn giá trị env lỗi để retry không tạo busy-loop hoặc giữ process quá lâu.
  private getPositiveConfig(
    key: string,
    fallback: number,
    minimum: number,
    maximum: number,
  ): number {
    const configured = Number(this.config.get<string>(key));
    return Number.isFinite(configured)
      ? Math.min(maximum, Math.max(minimum, Math.floor(configured)))
      : fallback;
  }
}
