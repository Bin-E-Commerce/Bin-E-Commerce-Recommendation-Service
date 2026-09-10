import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Consumer, Kafka } from "kafkajs";
import type { RecommendationEmbeddingGeneratedEvent } from "@common/kafka/events/recommendation.events";
import { CatalogProductRepository } from "../../modules/catalog/infrastructure/repositories/catalog-product.repository";
import { VectorIndexService } from "../../modules/catalog/application/services/vector/vector-index.service";
import { EmbeddingJobRepository } from "../../modules/catalog/infrastructure/repositories/embedding-job.repository";
import {
  RECOMMENDATION_EMBEDDING_DLQ_TOPIC,
  RECOMMENDATION_EMBEDDING_GENERATED_TOPIC,
  RECOMMENDATION_EMBEDDING_GROUP,
  getNextKafkaOffset,
} from "../config/kafka.constants";
import { KafkaProducerService } from "../producers/kafka-producer.service";
import { SemanticContentService } from "../../modules/catalog/application/services/semantic/semantic-content.service";

// Consumer group riêng cho embedding completion; AI/Qdrant retry không block interaction/profile projection.
@Injectable()
export class EmbeddingConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmbeddingConsumerService.name);
  private readonly consumer: Consumer;
  private started = false;
  private stopping = false;
  private restartTimer?: NodeJS.Timeout;

  constructor(
    private readonly config: ConfigService,
    private readonly catalog: CatalogProductRepository,
    private readonly vector: VectorIndexService,
    private readonly jobs: EmbeddingJobRepository,
    private readonly producer: KafkaProducerService,
    private readonly semantic: SemanticContentService,
  ) {
    const brokers = config
      .get<string>("KAFKA_BROKERS", "localhost:29092")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    this.consumer = new Kafka({
      clientId: "recommendation-embedding-consumer",
      brokers,
    }).consumer({
      groupId: RECOMMENDATION_EMBEDDING_GROUP,
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

  // Parse, validate freshness, upsert vector và cập nhật read model; lỗi giữ offset để Kafka redeliver.
  private async start(): Promise<void> {
    try {
      await this.consumer.connect();
      await this.consumer.subscribe({
        topic: RECOMMENDATION_EMBEDDING_GENERATED_TOPIC,
        fromBeginning: false,
      });
      this.started = true;
      await this.consumer.run({
        autoCommit: false,
        eachMessage: async ({ topic, partition, message }) => {
          const raw = message.value?.toString() ?? "";
          let event: RecommendationEmbeddingGeneratedEvent;
          try {
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            const data = parsed.data as Record<string, unknown> | undefined;
            const vector = data?.vector;
            if (
              parsed.eventName !==
                "recommendation.product_embedding.generated" ||
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
              vector.some(
                (value) => typeof value !== "number" || !Number.isFinite(value),
              )
            ) {
              throw new Error("INVALID_EMBEDDING_EVENT");
            }
            event = parsed as unknown as RecommendationEmbeddingGeneratedEvent;
          } catch {
            await this.producer.publish(
              RECOMMENDATION_EMBEDDING_DLQ_TOPIC,
              message.key?.toString() ?? "embedding-invalid",
              { errorCode: "INVALID_EMBEDDING_EVENT", raw: raw.slice(0, 2000) },
            );
            await this.consumer.commitOffsets([
              { topic, partition, offset: getNextKafkaOffset(message.offset) },
            ]);
            return;
          }
          const product = await this.catalog.findOne(event.data.productId);
          const expectedModel = this.config.get<string>(
            "EMBEDDING_MODEL_VERSION",
            this.config.get<string>(
              "EMBEDDING_MODEL",
              "text-embedding-3-small",
            ),
          );
          const isCurrentContent =
            product?.contentHash === event.data.contentHash;
          const configuredDimensions = Number(
            this.config.get<string>("QDRANT_VECTOR_SIZE", "1536"),
          );
          const expectedDimensions =
            Number.isInteger(configuredDimensions) && configuredDimensions > 0
              ? configuredDimensions
              : 1536;
          const isCompatible =
            event.data.modelVersion === expectedModel &&
            event.data.dimensions === expectedDimensions;
          if (!product || !isCurrentContent || !isCompatible) {
            // Product đã xóa hoặc completion không còn khớp job hiện tại thì không được để job quay lại queue vô hạn.
            if (!product || !isCurrentContent) {
              await this.jobs.markSuperseded({
                jobId: event.data.jobId,
                productId: event.data.productId,
                contentHash: event.data.contentHash,
                modelVersion: event.data.modelVersion,
                errorCode: !product
                  ? "EMBEDDING_PRODUCT_NOT_FOUND"
                  : "EMBEDDING_CONTENT_STALE",
              });
            }
            // Completion cũ không được làm bẩn trạng thái của content mới; chỉ đánh dấu stale khi nó còn trỏ đúng content hiện tại.
            if (product && isCurrentContent) {
              await this.catalog.updateEmbeddingState(product.productId, {
                status: "STALE",
                modelVersion: event.data.modelVersion,
                dimensions: event.data.dimensions,
              });
              // Tạo lại job theo model/dimension hiện tại để completion sai không khiến product mắc kẹt ở STALE vĩnh viễn.
              await this.jobs.enqueue({
                productId: product.productId,
                contentHash: product.contentHash!,
                embeddingProfile: "product-content-v1",
                modelVersion: expectedModel,
                textContent: this.semantic.toEmbeddingText({
                  title: product.name,
                  shortDescription: product.shortDescription,
                  description: product.description,
                  brandName: product.brandName,
                  categoryPath: product.categoryPath,
                  attributes: product.semanticAttributes,
                  contentHash: product.contentHash!,
                }),
              });
              await this.catalog.updateEmbeddingState(product.productId, {
                status: "PENDING",
                modelVersion: expectedModel,
                dimensions: expectedDimensions,
              });
            }
            await this.consumer.commitOffsets([
              { topic, partition, offset: getNextKafkaOffset(message.offset) },
            ]);
            return;
          }
          await this.vector.upsertProductVector({
            productId: product.productId,
            vector: event.data.vector,
            contentHash: product.contentHash!,
            modelVersion: event.data.modelVersion,
            catalogRevision: product.catalogVersion,
            originType: product.originType,
            categoryId: product.categoryId,
            brandId: product.brandId,
            sellerShopId: product.sellerShopId,
            externalShopId: product.externalShopId,
            minPrice: product.minPrice,
            maxPrice: product.maxPrice,
            status: product.status,
            isInStock: product.isInStock,
          });
          await this.catalog.updateEmbeddingState(product.productId, {
            status: "READY",
            modelVersion: event.data.modelVersion,
            dimensions: event.data.dimensions,
          });
          await this.jobs.markCompleted({
            jobId: event.data.jobId,
            productId: event.data.productId,
            contentHash: event.data.contentHash,
            modelVersion: event.data.modelVersion,
          });
          await this.consumer.commitOffsets([
            { topic, partition, offset: getNextKafkaOffset(message.offset) },
          ]);
        },
      });
    } catch (error) {
      this.logger.warn(
        `Embedding consumer unavailable: ${error instanceof Error ? error.message : "unknown"}`,
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
