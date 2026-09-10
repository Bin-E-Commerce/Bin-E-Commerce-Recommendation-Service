// File này tập trung tên topic và chính sách retry để producer, consumer và DLQ dùng cùng một contract.

export const RECOMMENDATION_INTERACTIONS_TOPIC =
  "recommendation.interactions.v1";
export const RECOMMENDATION_INTERACTIONS_DLQ_TOPIC =
  "recommendation.interactions.dlq.v1";
export const RECOMMENDATION_CATALOG_DLQ_TOPIC = "recommendation.catalog.dlq.v1";
export const RECOMMENDATION_PURCHASE_DLQ_TOPIC =
  "recommendation.purchase.dlq.v1";
export const RECOMMENDATION_EMBEDDING_REQUESTED_TOPIC =
  "recommendation.product-embedding.requested.v1";
export const RECOMMENDATION_EMBEDDING_GENERATED_TOPIC =
  "recommendation.product-embedding.generated.v1";
export const RECOMMENDATION_EMBEDDING_DLQ_TOPIC =
  "recommendation.product-embedding.dlq.v1";
export const RECOMMENDATION_RELATION_DLQ_TOPIC =
  "recommendation.relations.dlq.v1";
export const RECOMMENDATION_RELATION_GROUP = "recommendation-relations-v1";
export const RECOMMENDATION_EMBEDDING_GROUP = "recommendation-embeddings-v1";
export const DEFAULT_KAFKA_RETRY_ATTEMPTS = 3;
export const DEFAULT_KAFKA_RETRY_BASE_DELAY_MS = 250;
export const DEFAULT_KAFKA_RETRY_MAX_DELAY_MS = 5000;

// Tính offset kế tiếp bằng BigInt để không mất chính xác khi partition đã có rất nhiều message.
export function getNextKafkaOffset(offset: string): string {
  return (BigInt(offset) + 1n).toString();
}

// Tính backoff có jitter để nhiều consumer không cùng retry tại một thời điểm sau khi broker hồi phục.
export function getKafkaRetryDelayMs(
  attempt: number,
  baseDelayMs = DEFAULT_KAFKA_RETRY_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_KAFKA_RETRY_MAX_DELAY_MS,
): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const safeMax = Math.max(0, maxDelayMs);
  const exponential = Math.min(
    Math.max(0, baseDelayMs) * 2 ** (safeAttempt - 1),
    safeMax,
  );
  const jitter =
    exponential === 0
      ? 0
      : Math.floor(Math.random() * Math.max(1, exponential * 0.25));
  return Math.min(safeMax, exponential + jitter);
}
export const RECOMMENDATION_CATALOG_TOPICS = [
  "product.catalog.upserted",
  "product.catalog.status_changed",
  "product.catalog.availability_changed",
  "product.catalog.deleted",
] as const;
export const RECOMMENDATION_PURCHASE_TOPICS = [
  "order.purchase.completed",
  "order.purchase.returned",
] as const;

export const RECOMMENDATION_REPLAYABLE_TOPICS = [
  RECOMMENDATION_INTERACTIONS_TOPIC,
  ...RECOMMENDATION_CATALOG_TOPICS,
  ...RECOMMENDATION_PURCHASE_TOPICS,
  RECOMMENDATION_EMBEDDING_REQUESTED_TOPIC,
] as const;
