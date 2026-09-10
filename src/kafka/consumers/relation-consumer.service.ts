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
  getNextKafkaOffset,
  RECOMMENDATION_INTERACTIONS_TOPIC,
  RECOMMENDATION_PURCHASE_TOPICS,
  RECOMMENDATION_RELATION_DLQ_TOPIC,
  RECOMMENDATION_RELATION_GROUP,
} from "../config/kafka.constants";
import { RelationProjectionService } from "../../modules/relations/application/services/projection/relation-projection.service";
import { KafkaProducerService } from "../producers/kafka-producer.service";
import { validateInteractionEvent } from "../../modules/interactions/application/utils/interaction-event.validator";
import { validatePurchaseEvent } from "./validators/event.validators";

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
              message.key?.toString() ?? "relation-invalid",
              { errorCode: "INVALID_RELATION_EVENT", raw: raw.slice(0, 2000) },
            );
            await this.consumer.commitOffsets([
              { topic, partition, offset: getNextKafkaOffset(message.offset) },
            ]);
            return;
          }
          if (
            topic === RECOMMENDATION_INTERACTIONS_TOPIC &&
            event.eventName === RecommendationEvents.INTERACTION_RECORDED
          )
            await this.projection.projectInteraction(
              event as RecommendationInteractionRecordedEvent,
            );
          if (
            (RECOMMENDATION_PURCHASE_TOPICS as readonly string[]).includes(
              topic,
            )
          )
            await this.projection.projectPurchase(
              event as unknown as RecommendationPurchaseEvent,
            );
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
}
