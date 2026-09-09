// Consumer này chạy nền, chuyển raw Kafka message cho interaction processor và không làm chết loop khi một event lỗi.

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Consumer, Kafka } from "kafkajs";
import { InteractionMessageProcessor } from "./processors/interaction-message.processor";
import { CatalogService } from "../../modules/catalog/application/services/catalog/catalog.service";
import { ProfileProjectionService } from "../../modules/profiles/application/services/profile/profile-projection.service";
import { KafkaEventProcessor } from "./processors/kafka-event.processor";
import {
  validateCatalogEvent,
  validatePurchaseEvent,
} from "./validators/event.validators";
import {
  RECOMMENDATION_CATALOG_DLQ_TOPIC,
  RECOMMENDATION_CATALOG_TOPICS,
  RECOMMENDATION_INTERACTIONS_TOPIC,
  RECOMMENDATION_PURCHASE_DLQ_TOPIC,
  RECOMMENDATION_PURCHASE_TOPICS,
} from "../config/kafka.constants";

@Injectable()
export class KafkaConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaConsumerService.name);
  private readonly consumer: Consumer;
  private started = false;
  private restartTimer?: NodeJS.Timeout;

  // Cấu hình group riêng cho interaction stream để có thể scale consumer mà không ảnh hưởng service khác.
  constructor(
    private readonly config: ConfigService,
    private readonly processor: InteractionMessageProcessor,
    private readonly catalog: CatalogService,
    private readonly profile: ProfileProjectionService,
    private readonly eventProcessor: KafkaEventProcessor,
  ) {
    const brokers = this.config
      .get<string>("KAFKA_BROKERS", "localhost:29092")
      .split(",")
      .map((broker) => broker.trim())
      .filter(Boolean);

    this.consumer = new Kafka({
      clientId: this.config.get<string>(
        "KAFKA_CLIENT_ID",
        "recommendation-service",
      ),
      brokers,
      retry: { retries: 3 },
    }).consumer({
      groupId: this.config.get<string>(
        "KAFKA_CONSUMER_GROUP",
        "recommendation-interactions-v1",
      ),
    });
  }

  // Bắt đầu consumer không chặn bootstrap HTTP vì consumer.run là process loop dài hạn.
  async onModuleInit(): Promise<void> {
    void this.start();
  }

  // Disconnect an toàn nếu consumer đã kết nối thành công.
  async onModuleDestroy(): Promise<void> {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    await this.consumer.disconnect().catch(() => undefined);
    this.started = false;
  }

  // Subscribe interaction topic và giao từng message cho processor có retry/DLQ.
  private async start(): Promise<void> {
    try {
      await this.consumer.connect();
      for (const topic of [
        RECOMMENDATION_INTERACTIONS_TOPIC,
        ...RECOMMENDATION_CATALOG_TOPICS,
        ...RECOMMENDATION_PURCHASE_TOPICS,
      ]) {
        await this.consumer.subscribe({ topic, fromBeginning: false });
      }
      this.started = true;
      this.logger.log(
        `Kafka consumer subscribed to ${RECOMMENDATION_INTERACTIONS_TOPIC}`,
      );

      await this.consumer.run({
        eachMessage: async ({ topic, message }) => {
          const rawMessage = message.value?.toString() ?? "";
          if (topic === RECOMMENDATION_INTERACTIONS_TOPIC) {
            await this.processor.process(rawMessage);
            return;
          }
          if (
            (RECOMMENDATION_CATALOG_TOPICS as readonly string[]).includes(topic)
          ) {
            await this.eventProcessor.process(
              rawMessage,
              topic,
              RECOMMENDATION_CATALOG_DLQ_TOPIC,
              validateCatalogEvent,
              (event) => this.catalog.processEvent(event),
            );
            return;
          }
          await this.eventProcessor.process(
            rawMessage,
            topic,
            RECOMMENDATION_PURCHASE_DLQ_TOPIC,
            validatePurchaseEvent,
            (event) => this.profile.projectPurchase(event),
          );
        },
      });
    } catch (error) {
      this.logger.warn(
        `Kafka consumer is unavailable: ${this.getErrorMessage(error)}`,
      );
      await this.consumer.disconnect().catch(() => undefined);
      this.started = false;
      if (!this.restartTimer) {
        this.restartTimer = setTimeout(() => {
          this.restartTimer = undefined;
          void this.start();
        }, Number(this.config.get<string>("KAFKA_RECONNECT_DELAY_MS", "5000")));
      }
    }
  }

  // Chuẩn hóa lỗi kết nối để log ngắn gọn và không ghi raw message ra log.
  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "unknown error";
  }
}
