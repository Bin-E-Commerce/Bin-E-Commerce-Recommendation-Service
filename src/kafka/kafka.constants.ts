// File này tập trung tên topic và chính sách retry để producer, consumer và DLQ dùng cùng một contract.

export const RECOMMENDATION_INTERACTIONS_TOPIC = "recommendation.interactions.v1";
export const RECOMMENDATION_INTERACTIONS_DLQ_TOPIC =
  "recommendation.interactions.dlq.v1";
export const DEFAULT_KAFKA_RETRY_ATTEMPTS = 3;
