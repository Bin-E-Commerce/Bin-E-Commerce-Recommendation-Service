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
  private connecting?: Promise<void>;
  private stopping = false;

  // Khởi tạo producer theo môi trường; broker lỗi không làm mất khả năng health-check HTTP của service.
  constructor(private readonly config: ConfigService) {
    const brokers = this.config
      .get<string>("KAFKA_BROKERS", "localhost:29092")
      .split(",")
      .map((broker) => broker.trim())
      .filter(Boolean);

    this.producer = new Kafka({
      clientId: this.config.get<string>(
        "KAFKA_CLIENT_ID",
        "recommendation-service",
      ),
      brokers,
      retry: { retries: 3 },
    }).producer();
  }

  // Kết nối nền để service vẫn khởi động và log được trạng thái Kafka trong môi trường local thiếu broker.
  async onModuleInit(): Promise<void> {
    this.stopping = false;
    try {
      await this.ensureConnected();
    } catch (error) {
      this.logger.warn(
        `Kafka producer is unavailable: ${this.getErrorMessage(error)}`,
      );
    }
  }

  // Đóng producer khi Nest shutdown để flush connection sạch và không giữ process sống.
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (!this.connected) return;
    await this.producer.disconnect().catch(() => undefined);
    this.connected = false;
  }

  // Gửi event JSON theo actor key; nếu broker vừa hồi phục thì kết nối lại ngay trước khi publish.
  async publish(topic: string, key: string, payload: unknown): Promise<void> {
    if (this.stopping) throw new Error("Kafka producer is stopping");
    await this.ensureConnected();
    if (!this.connected) {
      throw new Error("Kafka producer is not connected");
    }

    try {
      await this.producer.send({
        topic,
        messages: [{ key, value: JSON.stringify(payload) }],
      });
    } catch (error) {
      // Đánh dấu disconnected để lần publish kế tiếp thực hiện handshake mới thay vì dùng socket lỗi.
      this.connected = false;
      await this.producer.disconnect().catch(() => undefined);
      throw error;
    }
  }

  // Gom các lần reconnect đồng thời thành một handshake để nhiều Kafka event không tạo nhiều socket cạnh tranh.
  private async ensureConnected(): Promise<void> {
    if (this.connected) return;
    if (this.stopping) throw new Error("Kafka producer is stopping");
    if (this.connecting) return this.connecting;

    this.connecting = this.producer
      .connect()
      .then(() => {
        this.connected = true;
        this.logger.log("Kafka producer connected");
      })
      .catch((error) => {
        this.connected = false;
        throw error;
      })
      .finally(() => {
        this.connecting = undefined;
      });

    return this.connecting;
  }

  // Trả trạng thái kết nối hiện tại để readiness không cần gửi thử một event nghiệp vụ.
  isConnected(): boolean {
    return this.connected;
  }

  // Chuẩn hóa lỗi ngoài để log không làm lộ payload hoặc secret từ exception.
  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "unknown error";
  }
}
