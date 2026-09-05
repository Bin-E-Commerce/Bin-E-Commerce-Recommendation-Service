// Validator này bảo vệ persistence boundary: chỉ event đúng version, actor và context mới được ghi vào database.

import {
  RecommendationEvents,
  RecommendationInteractionTypes,
} from "../../../../../../../packages/common/kafka/events/recommendation.events";
import { InvalidInteractionEventError } from "../errors/invalid-interaction-event.error";
import type { RecommendationInteractionRecordedEvent } from "../types/interaction-event.types";

const interactionTypeSet = new Set(Object.values(RecommendationInteractionTypes));

// Kiểm tra primitive bounded để Kafka consumer không nhận payload quá lớn hoặc sai kiểu.
function requireString(value: unknown, field: string, maxLength = 255): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new InvalidInteractionEventError(`${field} must be a non-empty bounded string`);
  }
  return value.trim();
}

// Kiểm tra field nullable nhưng vẫn giới hạn kích thước khi có giá trị.
function optionalString(value: unknown, field: string, maxLength = 255): string | null {
  if (value === null || value === undefined) return null;
  return requireString(value, field, maxLength);
}

// Chỉ giữ metadata trace được phép và giới hạn tổng kích thước để event không biến thành nơi lưu arbitrary payload.
function validateMetadata(value: unknown): RecommendationInteractionRecordedEvent["metadata"] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidInteractionEventError("metadata must be an object");
  }

  const metadata = value as Record<string, unknown>;
  const allowedKeys = ["correlationId", "causationId", "actorUserId"];
  if (Object.keys(metadata).some((key) => !allowedKeys.includes(key))) {
    throw new InvalidInteractionEventError("metadata contains unsupported fields");
  }

  const validated: Record<string, string> = {};
  for (const key of allowedKeys) {
    const currentValue = optionalString(metadata[key], `metadata.${key}`, 128);
    if (currentValue) validated[key] = currentValue;
  }
  return validated;
}

// Parse và validate toàn bộ envelope trước khi service application gọi repository.
export function validateInteractionEvent(
  input: unknown,
): RecommendationInteractionRecordedEvent {
  if (!input || typeof input !== "object") {
    throw new InvalidInteractionEventError("event must be an object");
  }

  const event = input as Record<string, unknown>;
  if (event.eventName !== RecommendationEvents.INTERACTION_RECORDED) {
    throw new InvalidInteractionEventError("eventName is not supported");
  }
  if (event.eventVersion !== 1) {
    throw new InvalidInteractionEventError("eventVersion must be 1");
  }
  const data = event.data;
  if (!data || typeof data !== "object") {
    throw new InvalidInteractionEventError("data must be an object");
  }

  const payload = data as Record<string, unknown>;
  const interactionType = requireString(payload.interactionType, "interactionType");
  if (!interactionTypeSet.has(interactionType as never)) {
    throw new InvalidInteractionEventError("interactionType is not supported");
  }

  const userId = optionalString(payload.userId, "userId");
  const sessionId = optionalString(payload.sessionId, "sessionId");
  if (!userId && !sessionId) {
    throw new InvalidInteractionEventError("event must contain userId or sessionId");
  }

  const occurredAt = requireString(event.occurredAt, "occurredAt", 64);
  if (Number.isNaN(Date.parse(occurredAt))) {
    throw new InvalidInteractionEventError("occurredAt must be an ISO date");
  }

  const productId = optionalString(payload.productId, "productId");
  const query = optionalString(payload.query, "query", 255);
  if (
    [
      RecommendationInteractionTypes.PRODUCT_VIEWED,
      RecommendationInteractionTypes.PRODUCT_CLICKED,
      RecommendationInteractionTypes.PRODUCT_IMPRESSED,
      RecommendationInteractionTypes.PRODUCT_ADDED_TO_CART,
      RecommendationInteractionTypes.PRODUCT_REMOVED_FROM_CART,
    ].includes(interactionType as never) &&
    !productId
  ) {
    throw new InvalidInteractionEventError("productId is required for product interaction");
  }
  if (interactionType === RecommendationInteractionTypes.SEARCH_PERFORMED && !query) {
    throw new InvalidInteractionEventError("query is required for search interaction");
  }

  const position = payload.position;
  if (position !== null && position !== undefined &&
      (typeof position !== "number" || !Number.isInteger(position) || position < 0 || position > 1000)) {
    throw new InvalidInteractionEventError("position must be an integer between 0 and 1000");
  }

  const quantity = payload.quantity;
  if (quantity !== null && quantity !== undefined &&
      (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > 10000)) {
    throw new InvalidInteractionEventError("quantity must be an integer between 1 and 10000");
  }

  return {
    eventId: requireString(event.eventId, "eventId", 128),
    eventName: RecommendationEvents.INTERACTION_RECORDED,
    eventVersion: 1,
    source: requireString(event.source, "source", 128),
    occurredAt,
    aggregateId: requireString(event.aggregateId, "aggregateId", 128),
    metadata: validateMetadata(event.metadata),
    data: {
      interactionType: interactionType as RecommendationInteractionRecordedEvent["data"]["interactionType"],
      userId,
      sessionId,
      productId,
      variantId: optionalString(payload.variantId, "variantId"),
      categoryId: optionalString(payload.categoryId, "categoryId"),
      query,
      page: optionalString(payload.page, "page", 80),
      position: position === null || position === undefined ? null : position,
      quantity: quantity === null || quantity === undefined ? null : quantity,
      requestId: optionalString(payload.requestId, "requestId", 128),
    },
  };
}
