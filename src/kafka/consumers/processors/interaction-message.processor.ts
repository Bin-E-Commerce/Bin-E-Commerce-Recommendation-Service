// Processor này định nghĩa retry/DLQ baseline cho Kafka; malformed event không được retry vì retry không thể sửa payload.

import { Injectable, Logger } from "@nestjs/common";
import { KafkaProducerService } from "../../producers/kafka-producer.service";
import {
  DEFAULT_KAFKA_RETRY_ATTEMPTS,
  RECOMMENDATION_INTERACTIONS_DLQ_TOPIC,
} from "../../config/kafka.constants";
import { InvalidInteractionEventError } from "../../../modules/interactions/application/errors/invalid-interaction-event.error";
import { InteractionProcessingService } from "../../../modules/interactions/application/services/interaction-processing.service";

@Injectable()
export class InteractionMessageProcessor {
  private readonly logger = new Logger(InteractionMessageProcessor.name);

  // Processor nhận application service và producer để test được retry/DLQ mà không cần Kafka thật.
  constructor(
    private readonly processingService: InteractionProcessingService,
    private readonly kafkaProducer: KafkaProducerService,
  ) {}

  // Xử lý raw message, retry lỗi hạ tầng tối đa ba lần rồi gửi bản gốc cùng reason vào DLQ.
  async process(rawMessage: string): Promise<void> {
    let payload: unknown;
    try {
      payload = JSON.parse(rawMessage);
    } catch {
      await this.publishDeadLetter(rawMessage, "invalid JSON");
      return;
    }

    for (let attempt = 1; attempt <= DEFAULT_KAFKA_RETRY_ATTEMPTS; attempt += 1) {
      try {
        await this.processingService.process(payload);
        return;
      } catch (error) {
        const reason = this.getErrorMessage(error);
        if (error instanceof InvalidInteractionEventError || attempt === DEFAULT_KAFKA_RETRY_ATTEMPTS) {
          await this.publishDeadLetter(payload, reason);
          return;
        }

        this.logger.warn(`Interaction processing retry ${attempt}: ${reason}`);
      }
    }
  }

  // DLQ key ưu tiên eventId nếu payload có thể đọc được, giúp audit/replay tìm event ổn định.
  private async publishDeadLetter(payload: unknown, reason: string): Promise<void> {
    const eventId =
      typeof payload === "object" && payload !== null && "eventId" in payload
        ? String((payload as { eventId?: unknown }).eventId ?? "unknown")
        : "unknown";

    await this.kafkaProducer.publish(RECOMMENDATION_INTERACTIONS_DLQ_TOPIC, eventId, {
      failedAt: new Date().toISOString(),
      reason,
      originalEvent: payload,
    });
    this.logger.error(`Interaction moved to DLQ: ${eventId} (${reason})`);
  }

  // Chuẩn hóa exception để DLQ chỉ lưu thông tin lỗi cần thiết.
  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "unknown processing error";
  }
}
