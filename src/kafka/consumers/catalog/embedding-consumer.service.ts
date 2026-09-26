import {
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Consumer, Kafka } from 'kafkajs';
import type { RecommendationEmbeddingGeneratedEvent } from '@common/kafka/events/recommendation.events';
import { CatalogProductRepository } from '@/modules/catalog/infrastructure/repositories/catalog-product.repository';
import { VectorIndexService } from '@/modules/catalog/application/services/vector/vector-index.service';
import { EmbeddingJobRepository } from '@/modules/catalog/infrastructure/repositories/embedding-job.repository';
import {
    RECOMMENDATION_EMBEDDING_DLQ_TOPIC,
    RECOMMENDATION_EMBEDDING_GENERATED_TOPIC,
    RECOMMENDATION_EMBEDDING_GROUP,
    getNextKafkaOffset,
} from '@/kafka/config/kafka.constants';
import { KafkaProducerService } from '@/kafka/producers/kafka-producer.service';
import { MetricsService } from '@/modules/health/metrics.service';

// Consumer group riêng cho embedding completion; AI/Qdrant retry không block interaction/profile projection.
@Injectable()
export class EmbeddingConsumerService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(EmbeddingConsumerService.name);
    private readonly consumer: Consumer;
    private started = false;
    private stopping = false;
    private restartTimer?: NodeJS.Timeout;
    private failureCount = 0;

    constructor(
        private readonly config: ConfigService,
        private readonly catalog: CatalogProductRepository,
        private readonly vector: VectorIndexService,
        private readonly jobs: EmbeddingJobRepository,
        private readonly producer: KafkaProducerService,
        private readonly metrics: MetricsService,
    ) {
        const brokers = config
            .get<string>('KAFKA_BROKERS', 'localhost:29092')
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
        this.consumer = new Kafka({
            clientId: 'recommendation-embedding-consumer',
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
            this.failureCount = 0;
            this.metrics.setGauge(
                'recommendation_kafka_consumer_available',
                1,
                {
                    consumer: RECOMMENDATION_EMBEDDING_GROUP,
                    topic: RECOMMENDATION_EMBEDDING_GENERATED_TOPIC,
                },
            );
            this.metrics.increment(
                'recommendation_kafka_consumer_connected_total',
                {
                    consumer: RECOMMENDATION_EMBEDDING_GROUP,
                },
            );
            await this.consumer.run({
                autoCommit: false,
                eachMessage: async ({ topic, partition, message }) => {
                    const raw = message.value?.toString() ?? '';
                    let event: RecommendationEmbeddingGeneratedEvent;
                    try {
                        const parsed = JSON.parse(raw) as Record<
                            string,
                            unknown
                        >;
                        const data = parsed.data as
                            Record<string, unknown> | undefined;
                        const vector = data?.vector;
                        if (
                            parsed.eventName !==
                                'recommendation.product_embedding.generated' ||
                            parsed.eventVersion !== 1 ||
                            typeof parsed.eventId !== 'string' ||
                            typeof parsed.source !== 'string' ||
                            typeof parsed.aggregateId !== 'string' ||
                            typeof parsed.occurredAt !== 'string' ||
                            Number.isNaN(Date.parse(parsed.occurredAt)) ||
                            !data ||
                            typeof data.jobId !== 'string' ||
                            typeof data.productId !== 'string' ||
                            typeof data.contentHash !== 'string' ||
                            typeof data.model !== 'string' ||
                            !data.model.trim() ||
                            typeof data.modelVersion !== 'string' ||
                            !data.modelVersion.trim() ||
                            typeof data.dimensions !== 'number' ||
                            !Number.isInteger(data.dimensions) ||
                            data.dimensions <= 0 ||
                            !Array.isArray(vector) ||
                            vector.length !== data.dimensions ||
                            vector.some(
                                (value) =>
                                    typeof value !== 'number' ||
                                    !Number.isFinite(value),
                            )
                        ) {
                            throw new Error('INVALID_EMBEDDING_EVENT');
                        }
                        event =
                            parsed as unknown as RecommendationEmbeddingGeneratedEvent;
                    } catch {
                        await this.producer.publish(
                            RECOMMENDATION_EMBEDDING_DLQ_TOPIC,
                            message.key?.toString() ?? 'embedding-invalid',
                            {
                                errorCode: 'INVALID_EMBEDDING_EVENT',
                                raw: raw.slice(0, 2000),
                            },
                        );
                        await this.consumer.commitOffsets([
                            {
                                topic,
                                partition,
                                offset: getNextKafkaOffset(message.offset),
                            },
                        ]);
                        return;
                    }
                    const product = await this.catalog.findOne(
                        event.data.productId,
                    );
                    const expectedModel = this.config.get<string>(
                        'EMBEDDING_MODEL_VERSION',
                        this.config.get<string>(
                            'EMBEDDING_MODEL',
                            'text-embedding-3-small',
                        ),
                    );
                    const isCurrentContent =
                        product?.contentHash === event.data.contentHash;
                    const configuredDimensions = Number(
                        this.config.get<string>('QDRANT_VECTOR_SIZE', '1536'),
                    );
                    const expectedDimensions =
                        Number.isInteger(configuredDimensions) &&
                        configuredDimensions > 0
                            ? configuredDimensions
                            : 1536;
                    const isCompatible =
                        event.data.modelVersion === expectedModel &&
                        event.data.dimensions === expectedDimensions;
                    if (!product || !isCurrentContent || !isCompatible) {
                        // Completion cũ không được ghi đè content hiện tại; job tương ứng chỉ cần kết thúc ở trạng thái superseded.
                        await this.jobs.markSuperseded({
                            jobId: event.data.jobId,
                            productId: event.data.productId,
                            contentHash: event.data.contentHash,
                            modelVersion: event.data.modelVersion,
                            errorCode: !product
                                ? 'EMBEDDING_PRODUCT_NOT_FOUND'
                                : !isCurrentContent
                                  ? 'EMBEDDING_CONTENT_STALE'
                                  : 'EMBEDDING_MODEL_STALE',
                        });
                        await this.consumer.commitOffsets([
                            {
                                topic,
                                partition,
                                offset: getNextKafkaOffset(message.offset),
                            },
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
                        embeddingStatus: 'READY',
                    });
                    // Chỉ chuyển sang READY nếu contentHash chưa đổi trong lúc Qdrant đang xử lý.
                    const stateUpdated =
                        await this.catalog.updateEmbeddingState(
                            product.productId,
                            {
                                status: 'READY',
                                modelVersion: event.data.modelVersion,
                                dimensions: event.data.dimensions,
                            },
                            event.data.contentHash,
                        );
                    if (!stateUpdated) {
                        await this.jobs.markSuperseded({
                            jobId: event.data.jobId,
                            productId: event.data.productId,
                            contentHash: event.data.contentHash,
                            modelVersion: event.data.modelVersion,
                            errorCode: 'EMBEDDING_CONTENT_STALE',
                        });
                        await this.consumer.commitOffsets([
                            {
                                topic,
                                partition,
                                offset: getNextKafkaOffset(message.offset),
                            },
                        ]);
                        return;
                    }
                    await this.jobs.markCompleted({
                        jobId: event.data.jobId,
                        productId: event.data.productId,
                        contentHash: event.data.contentHash,
                        modelVersion: event.data.modelVersion,
                    });
                    await this.consumer.commitOffsets([
                        {
                            topic,
                            partition,
                            offset: getNextKafkaOffset(message.offset),
                        },
                    ]);
                },
            });
        } catch (error) {
            this.failureCount += 1;
            this.metrics.setGauge(
                'recommendation_kafka_consumer_available',
                0,
                {
                    consumer: RECOMMENDATION_EMBEDDING_GROUP,
                    topic: RECOMMENDATION_EMBEDDING_GENERATED_TOPIC,
                },
            );
            this.metrics.increment(
                'recommendation_kafka_consumer_errors_total',
                {
                    consumer: RECOMMENDATION_EMBEDDING_GROUP,
                    topic: RECOMMENDATION_EMBEDDING_GENERATED_TOPIC,
                },
            );
            // Kafka có thể lặp lỗi metadata khi broker chưa có leader; chỉ log lần đầu và mỗi phút để Loki không bị ngập.
            if (this.failureCount === 1 || this.failureCount % 12 === 0) {
                this.logger.warn(
                    `Embedding consumer unavailable: ${error instanceof Error ? error.message : 'unknown'}`,
                );
            }
            if (this.started)
                await this.consumer.disconnect().catch(() => undefined);
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
