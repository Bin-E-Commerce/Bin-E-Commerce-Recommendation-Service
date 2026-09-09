import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { KafkaProducerService } from "../../../../../kafka/producers/kafka-producer.service";
import { RECOMMENDATION_EMBEDDING_REQUESTED_TOPIC } from "../../../../../kafka/config/kafka.constants";
import type { RecommendationEmbeddingRequestedEvent } from "@common/kafka/events/recommendation.events";
import { EmbeddingJobRepository } from "../../../infrastructure/repositories/embedding-job.repository";

// Dispatcher bền vững giữa PostgreSQL job và Kafka; không gọi AI provider trong request path.
@Injectable()
export class EmbeddingJobService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmbeddingJobService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly jobs: EmbeddingJobRepository,
    private readonly producer: KafkaProducerService,
    private readonly config: ConfigService,
  ) {}

  // Tạo hoặc réact một job theo content hash; caller đã commit catalog snapshot trước khi gọi hàm này.
  async enqueueProduct(input: { productId: string; contentHash: string; textContent: string }): Promise<void> {
    await this.jobs.enqueue({
      ...input,
      embeddingProfile: "product-content-v1",
      modelVersion: this.config.get<string>("EMBEDDING_MODEL_VERSION", this.config.get<string>("EMBEDDING_MODEL", "text-embedding-3-small")),
    });
  }

  // Poll nhẹ sau bootstrap; dispatcher lỗi không làm HTTP serving process chết.
  onModuleInit(): void {
    if (this.config.get<string>("EMBEDDING_DISPATCHER_ENABLED", "true") !== "true") return;
    this.timer = setInterval(() => void this.dispatch(), Number(this.config.get<string>("EMBEDDING_DISPATCH_INTERVAL_MS", "1000")));
    void this.dispatch();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // Lease/publish từng batch, retry còn lại trong database nếu broker không khả dụng.
  private async dispatch(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const jobs = await this.jobs.leaseBatch(
        Number(this.config.get<string>("EMBEDDING_DISPATCH_BATCH_SIZE", "20")),
        Number(this.config.get<string>("EMBEDDING_JOB_LEASE_SECONDS", "120")),
      );
      for (const job of jobs) {
        try {
          const event: RecommendationEmbeddingRequestedEvent = {
            eventId: `embedding:${job.jobId}:${job.contentHash}`,
            eventName: "recommendation.product_embedding.requested",
            eventVersion: 1,
            source: "recommendation-service",
            aggregateId: job.productId,
            occurredAt: new Date().toISOString(),
            data: {
              jobId: job.jobId,
              productId: job.productId,
              contentHash: job.contentHash,
              embeddingProfile: job.embeddingProfile,
              modelVersion: job.modelVersion,
              text: job.textContent,
            },
          };
          await this.producer.publish(RECOMMENDATION_EMBEDDING_REQUESTED_TOPIC, job.productId, event);
          await this.jobs.markDispatched(job.jobId);
        } catch (error) {
          await this.jobs.markRetry(job.jobId, error instanceof Error ? error.name : "PUBLISH_FAILED", Math.pow(2, Math.min(job.attemptCount, 8)));
        }
      }
    } catch (error) {
      this.logger.warn(`Embedding dispatcher deferred: ${error instanceof Error ? error.message : "unknown"}`);
    } finally {
      this.running = false;
    }
  }
}
