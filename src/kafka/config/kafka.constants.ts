// File này tập trung tên topic và chính sách retry để producer, consumer và DLQ dùng cùng một contract.

export const RECOMMENDATION_INTERACTIONS_TOPIC = "recommendation.interactions.v1";
export const RECOMMENDATION_INTERACTIONS_DLQ_TOPIC =
  "recommendation.interactions.dlq.v1";
export const RECOMMENDATION_CATALOG_DLQ_TOPIC =
  "recommendation.catalog.dlq.v1";
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
