// Processor dùng chung cho catalog/purchase: parse, validate, retry handler và đẩy event lỗi vào DLQ theo đúng topic domain.

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { KafkaProducerService } from "../../producers/kafka-producer.service";
import { MetricsService } from "../../../modules/health/metrics.service";
import {
  DEFAULT_KAFKA_RETRY_ATTEMPTS,
  DEFAULT_KAFKA_RETRY_BASE_DELAY_MS,
  DEFAULT_KAFKA_RETRY_MAX_DELAY_MS,
  getKafkaRetryDelayMs,
} from "../../config/kafka.constants";

export class InvalidKafkaEventError extends Error {}

type EventValidator<T> = (input: unknown) => T;

@Injectable()
export class KafkaEventProcessor {
  private readonly logger = new Logger(KafkaEventProcessor.name);

  constructor(
    private readonly producer: KafkaProducerService,
    private readonly config?: ConfigService,
    private readonly metrics?: MetricsService,
  ) {}

  // Event sai schema được đưa thẳng vào DLQ; lỗi xử lý hạ tầng được retry giới hạn để không block consumer vô hạn.
  async process<T>(
    rawMessage: string,
    sourceTopic: string,
    dlqTopic: string,
    validate: EventValidator<T>,
    handler: (event: T) => Promise<void>,
  ): Promise<void> {
    let payload: unknown;
    try {
      payload = JSON.parse(rawMessage);
    } catch {
      await this.publishDeadLetter(
        dlqTopic,
        sourceTopic,
        rawMessage,
        "invalid JSON",
      );
      this.metrics?.increment("recommendation_kafka_messages_dlq_total", {
        source: sourceTopic,
        reason: "invalid_json",
      });
      return;
    }

    let event: T;
    try {
      event = validate(payload);
    } catch (error) {
      await this.publishDeadLetter(
        dlqTopic,
        sourceTopic,
        payload,
        this.getErrorMessage(error),
      );
      this.metrics?.increment("recommendation_kafka_messages_dlq_total", {
        source: sourceTopic,
        reason: "invalid_schema",
      });
      return;
    }

    for (
      let attempt = 1;
      attempt <= DEFAULT_KAFKA_RETRY_ATTEMPTS;
      attempt += 1
    ) {
      try {
        await handler(event);
        this.metrics?.increment(
          "recommendation_kafka_messages_processed_total",
          {
            source: sourceTopic,
            status: "success",
          },
        );
        return;
      } catch (error) {
        const reason = this.getErrorMessage(error);
        if (attempt === DEFAULT_KAFKA_RETRY_ATTEMPTS) {
          await this.publishDeadLetter(dlqTopic, sourceTopic, payload, reason);
          this.metrics?.increment("recommendation_kafka_messages_dlq_total", {
            source: sourceTopic,
          });
          return;
        }
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            getKafkaRetryDelayMs(
              attempt,
              Number(
                this.config?.get<string>(
                  "KAFKA_RETRY_BASE_DELAY_MS",
                  String(DEFAULT_KAFKA_RETRY_BASE_DELAY_MS),
                ),
              ),
              Number(
                this.config?.get<string>(
                  "KAFKA_RETRY_MAX_DELAY_MS",
                  String(DEFAULT_KAFKA_RETRY_MAX_DELAY_MS),
                ),
              ),
            ),
          ),
        );
        this.metrics?.increment("recommendation_kafka_retries_total", {
          source: sourceTopic,
        });
        this.logger.warn(
          `${sourceTopic} processing retry ${attempt}: ${reason}`,
        );
      }
    }
  }

  // DLQ giữ event gốc và metadata tối thiểu để replay/audit mà không ghi stack trace hoặc secret vào Kafka.
  private async publishDeadLetter(
    dlqTopic: string,
    sourceTopic: string,
    payload: unknown,
    reason: string,
  ): Promise<void> {
    const eventId =
      typeof payload === "object" && payload !== null && "eventId" in payload
        ? String((payload as { eventId?: unknown }).eventId ?? "unknown")
        : "unknown";

    await this.producer.publish(dlqTopic, eventId, {
      eventVersion: 1,
      eventId: "dlq:" + sourceTopic + ":" + eventId + ":" + Date.now(),
      eventName: "recommendation.processing.failed",
      failedAt: new Date().toISOString(),
      sourceTopic,
      reason,
      originalEvent: payload,
    });
    this.logger.error(
      `${sourceTopic} event moved to ${dlqTopic}: ${eventId} (${reason})`,
    );
  }

  // Chuẩn hóa lỗi về message ngắn để DLQ không làm lộ thông tin nội bộ của database hoặc runtime.
  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "unknown processing error";
  }
}
