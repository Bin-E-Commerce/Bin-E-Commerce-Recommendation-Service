// Consumer này chạy nền, chuyển raw Kafka message cho interaction processor và không làm chết loop khi một event lỗi.

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Consumer, Kafka } from "kafkajs";
import { InteractionMessageProcessor } from "../../modules/interactions/application/services/interaction-message-processor.service";
import { RECOMMENDATION_INTERACTIONS_TOPIC } from "../kafka.constants";

@Injectable()
export class KafkaConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaConsumerService.name);
  private readonly consumer: Consumer;
  private started = false;

  // Cấu hình group riêng cho interaction stream để có thể scale consumer mà không ảnh hưởng service khác.
  constructor(
    private readonly config: ConfigService,
    private readonly processor: InteractionMessageProcessor,
  ) {
    const brokers = this.config
      .get<string>("KAFKA_BROKERS", "localhost:29092")
      .split(",")
      .map((broker) => broker.trim())
      .filter(Boolean);

    this.consumer = new Kafka({
      clientId: this.config.get<string>("KAFKA_CLIENT_ID", "recommendation-service"),
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
    if (!this.started) return;
    await this.consumer.disconnect();
    this.started = false;
  }

  // Subscribe interaction topic và giao từng message cho processor có retry/DLQ.
  private async start(): Promise<void> {
    try {
      await this.consumer.connect();
      await this.consumer.subscribe({
        topic: RECOMMENDATION_INTERACTIONS_TOPIC,
        fromBeginning: false,
      });
      this.started = true;
      this.logger.log(`Kafka consumer subscribed to ${RECOMMENDATION_INTERACTIONS_TOPIC}`);

      await this.consumer.run({
        eachMessage: async ({ message }) => {
          await this.processor.process(message.value?.toString() ?? "");
        },
      });
    } catch (error) {
      this.logger.warn(
        `Kafka consumer is unavailable: ${this.getErrorMessage(error)}`,
      );
    }
  }

  // Chuẩn hóa lỗi kết nối để log ngắn gọn và không ghi raw message ra log.
  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "unknown error";
  }
}
