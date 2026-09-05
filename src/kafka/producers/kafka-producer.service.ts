// Producer này gửi interaction đã được Gateway chấp nhận vào Kafka và báo lỗi rõ ràng khi chưa queue được event.

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Kafka, Producer } from "kafkajs";

@Injectable()
export class KafkaProducerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaProducerService.name);
  private readonly producer: Producer;
  private connected = false;

  // Khởi tạo producer theo môi trường; broker lỗi không làm mất khả năng health-check HTTP của service.
  constructor(private readonly config: ConfigService) {
    const brokers = this.config
      .get<string>("KAFKA_BROKERS", "localhost:29092")
      .split(",")
      .map((broker) => broker.trim())
      .filter(Boolean);

    this.producer = new Kafka({
      clientId: this.config.get<string>("KAFKA_CLIENT_ID", "recommendation-service"),
      brokers,
      retry: { retries: 3 },
    }).producer();
  }

  // Kết nối nền để service vẫn khởi động và log được trạng thái Kafka trong môi trường local thiếu broker.
  async onModuleInit(): Promise<void> {
    try {
      await this.producer.connect();
      this.connected = true;
      this.logger.log("Kafka producer connected");
    } catch (error) {
      this.logger.warn(`Kafka producer is unavailable: ${this.getErrorMessage(error)}`);
    }
  }

  // Đóng producer khi Nest shutdown để flush connection sạch và không giữ process sống.
  async onModuleDestroy(): Promise<void> {
    if (!this.connected) return;
    await this.producer.disconnect();
    this.connected = false;
  }

  // Gửi event JSON theo actor key để giữ thứ tự interaction trong cùng user/session.
  async publish(topic: string, key: string, payload: unknown): Promise<void> {
    if (!this.connected) {
      throw new Error("Kafka producer is not connected");
    }

    await this.producer.send({
      topic,
      messages: [{ key, value: JSON.stringify(payload) }],
    });
  }

  // Chuẩn hóa lỗi ngoài để log không làm lộ payload hoặc secret từ exception.
  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "unknown error";
  }
}
