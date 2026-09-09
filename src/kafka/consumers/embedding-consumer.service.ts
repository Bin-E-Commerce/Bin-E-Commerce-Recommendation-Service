import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Consumer, Kafka } from "kafkajs";
import type { RecommendationEmbeddingGeneratedEvent } from "@common/kafka/events/recommendation.events";
import { CatalogProductRepository } from "../../modules/catalog/infrastructure/repositories/catalog-product.repository";
import { VectorIndexService } from "../../modules/catalog/application/services/vector/vector-index.service";
import { EmbeddingJobRepository } from "../../modules/catalog/infrastructure/repositories/embedding-job.repository";
import { RECOMMENDATION_EMBEDDING_DLQ_TOPIC, RECOMMENDATION_EMBEDDING_GENERATED_TOPIC, RECOMMENDATION_EMBEDDING_GROUP } from "../config/kafka.constants";
import { KafkaProducerService } from "../producers/kafka-producer.service";

// Consumer group riêng cho embedding completion; AI/Qdrant retry không block interaction/profile projection.
@Injectable()
export class EmbeddingConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmbeddingConsumerService.name);
  private readonly consumer: Consumer;
  private started = false;
  private restartTimer?: NodeJS.Timeout;

  constructor(
    private readonly config: ConfigService,
    private readonly catalog: CatalogProductRepository,
    private readonly vector: VectorIndexService,
    private readonly jobs: EmbeddingJobRepository,
    private readonly producer: KafkaProducerService,
  ) {
    const brokers = config.get<string>("KAFKA_BROKERS", "localhost:29092").split(",").map((item) => item.trim()).filter(Boolean);
    this.consumer = new Kafka({ clientId: "recommendation-embedding-consumer", brokers }).consumer({ groupId: RECOMMENDATION_EMBEDDING_GROUP, allowAutoTopicCreation: false });
  }

  onModuleInit(): void { void this.start(); }

  async onModuleDestroy(): Promise<void> {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.started) await this.consumer.disconnect();
  }

  // Parse, validate freshness, upsert vector và cập nhật read model; lỗi giữ offset để Kafka redeliver.
  private async start(): Promise<void> {
    try {
      await this.consumer.connect();
      await this.consumer.subscribe({ topic: RECOMMENDATION_EMBEDDING_GENERATED_TOPIC, fromBeginning: false });
      this.started = true;
      await this.consumer.run({ autoCommit: false, eachMessage: async ({ topic, partition, message }) => {
        const raw = message.value?.toString() ?? "";
        let event: RecommendationEmbeddingGeneratedEvent;
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          const data = parsed.data as Record<string, unknown> | undefined;
          const vector = data?.vector;
          if (
            parsed.eventName !== "recommendation.product_embedding.generated" ||
            parsed.eventVersion !== 1 ||
            typeof parsed.eventId !== "string" ||
            typeof parsed.source !== "string" ||
            typeof parsed.aggregateId !== "string" ||
            typeof parsed.occurredAt !== "string" ||
            Number.isNaN(Date.parse(parsed.occurredAt)) ||
            !data ||
            typeof data.jobId !== "string" ||
            typeof data.productId !== "string" ||
            typeof data.contentHash !== "string" ||
            typeof data.modelVersion !== "string" ||
            typeof data.dimensions !== "number" ||
            !Number.isInteger(data.dimensions) ||
            data.dimensions <= 0 ||
            !Array.isArray(vector) ||
            vector.length !== data.dimensions ||
            vector.some((value) => typeof value !== "number" || !Number.isFinite(value))
          ) {
            throw new Error("INVALID_EMBEDDING_EVENT");
          }
          event = parsed as unknown as RecommendationEmbeddingGeneratedEvent;
        } catch {
          await this.producer.publish(RECOMMENDATION_EMBEDDING_DLQ_TOPIC, message.key?.toString() ?? "embedding-invalid", { errorCode: "INVALID_EMBEDDING_EVENT", raw: raw.slice(0, 2000) });
          await this.consumer.commitOffsets([{ topic, partition, offset: String(Number(message.offset) + 1) }]);
          return;
        }
        const product = await this.catalog.findOne(event.data.productId);
        const expectedModel = this.config.get<string>("EMBEDDING_MODEL_VERSION", this.config.get<string>("EMBEDDING_MODEL", "text-embedding-3-small"));
        const isCurrentContent = product?.contentHash === event.data.contentHash;
        const configuredDimensions = Number(this.config.get<string>("QDRANT_VECTOR_SIZE", "1536"));
        const expectedDimensions = Number.isInteger(configuredDimensions) && configuredDimensions > 0 ? configuredDimensions : 1536;
        const isCompatible = event.data.modelVersion === expectedModel && event.data.dimensions === expectedDimensions;
        if (!product || !isCurrentContent || !isCompatible) {
          // Completion cũ không được làm bẩn trạng thái của content mới; chỉ đánh dấu stale khi nó còn trỏ đúng content hiện tại.
          if (product && isCurrentContent) await this.catalog.updateEmbeddingState(product.productId, { status: "STALE", modelVersion: event.data.modelVersion, dimensions: event.data.dimensions });
          await this.consumer.commitOffsets([{ topic, partition, offset: String(Number(message.offset) + 1) }]);
          return;
        }
        await this.vector.upsertProductVector({ productId: product.productId, vector: event.data.vector, contentHash: product.contentHash!, modelVersion: event.data.modelVersion, catalogRevision: product.catalogVersion, originType: product.originType, categoryId: product.categoryId, brandId: product.brandId, sellerShopId: product.sellerShopId, externalShopId: product.externalShopId, minPrice: product.minPrice, maxPrice: product.maxPrice, status: product.status, isInStock: product.isInStock });
        await this.catalog.updateEmbeddingState(product.productId, { status: "READY", modelVersion: event.data.modelVersion, dimensions: event.data.dimensions });
        await this.jobs.markCompleted(event.data.jobId);
        await this.consumer.commitOffsets([{ topic, partition, offset: String(Number(message.offset) + 1) }]);
      }});
    } catch (error) {
      this.logger.warn(`Embedding consumer unavailable: ${error instanceof Error ? error.message : "unknown"}`);
      if (this.started) await this.consumer.disconnect().catch(() => undefined);
      this.started = false;
      this.restartTimer = setTimeout(() => void this.start(), 5000);
    }
  }
}
