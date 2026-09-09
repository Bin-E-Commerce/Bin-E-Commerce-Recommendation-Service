// Validator bảo vệ persistence boundary của catalog/purchase trước khi event đi vào projection hoặc read model.

import type {
  RecommendationCatalogEvent,
  RecommendationPurchaseEvent,
} from "../../../../../../packages/common/kafka/events/recommendation.events";
import {
  RecommendationCatalogEvents,
  RecommendationPurchaseEvents,
} from "../../../../../../packages/common/kafka/events/recommendation.events";
import { InvalidKafkaEventError } from "../processors/kafka-event.processor";

const catalogEventNames = new Set<string>(
  Object.values(RecommendationCatalogEvents),
);
const purchaseEventNames = new Set<string>(
  Object.values(RecommendationPurchaseEvents),
);

// Kiểm tra string bounded để tránh event lỗi hoặc payload quá lớn đi vào database.
function requireString(value: unknown, field: string, maxLength = 255): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength
  ) {
    throw new InvalidKafkaEventError(
      `${field} must be a non-empty bounded string`,
    );
  }
  return value.trim();
}

// Kiểm tra timestamp event để read model không lưu Date Invalid hoặc làm hỏng thứ tự projection.
function requireIsoDate(value: unknown, field: string): string {
  const date = requireString(value, field, 64);
  if (Number.isNaN(Date.parse(date))) {
    throw new InvalidKafkaEventError(`${field} must be an ISO date`);
  }
  return date;
}

// Kiểm tra envelope chung và ngày ISO của integration event.
function requireEnvelope(
  input: unknown,
  eventNames: Set<string>,
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new InvalidKafkaEventError("event must be an object");
  }
  const event = input as Record<string, unknown>;
  if (typeof event.eventName !== "string" || !eventNames.has(event.eventName)) {
    throw new InvalidKafkaEventError("eventName is not supported");
  }
  if (event.eventVersion !== 1) {
    throw new InvalidKafkaEventError("eventVersion must be 1");
  }
  requireString(event.eventId, "eventId", 128);
  requireString(event.source, "source", 128);
  requireString(event.aggregateId, "aggregateId", 128);
  requireIsoDate(event.occurredAt, "occurredAt");
  if (
    !event.data ||
    typeof event.data !== "object" ||
    Array.isArray(event.data)
  ) {
    throw new InvalidKafkaEventError("data must be an object");
  }
  return event;
}

// Validate catalog snapshot trước khi upsert để status/stock/version luôn có kiểu dữ liệu hợp lệ.
export function validateCatalogEvent(
  input: unknown,
): RecommendationCatalogEvent {
  const event = requireEnvelope(input, catalogEventNames);
  const data = event.data as Record<string, unknown>;
  requireString(data.productId, "data.productId", 128);
  requireString(data.name, "data.name", 500);
  requireString(data.slug, "data.slug", 620);
  if (data.originType !== "INTERNAL" && data.originType !== "EXTERNAL") {
    throw new InvalidKafkaEventError("data.originType is not supported");
  }
  if (!catalogEventNames.has(String(event.eventName))) {
    throw new InvalidKafkaEventError("catalog eventName is not supported");
  }
  if (
    !data.status ||
    !["ACTIVE", "INACTIVE", "DELETED"].includes(String(data.status))
  ) {
    throw new InvalidKafkaEventError("data.status is not supported");
  }
  if (typeof data.isInStock !== "boolean") {
    throw new InvalidKafkaEventError("data.isInStock must be boolean");
  }
  const rawRevision = data.catalogRevision ?? data.catalogVersion;
  const catalogVersion = typeof rawRevision === "number" && Number.isInteger(rawRevision)
    ? String(rawRevision)
    : rawRevision;
  if (typeof catalogVersion !== "string" || !/^\d+$/.test(catalogVersion) || BigInt(catalogVersion) < 1n) {
    throw new InvalidKafkaEventError(
      "data.catalogVersion must be a positive numeric string",
    );
  }
  // Cho phép replay event Phase 2 cũ; snapshot fallback chỉ dùng title nên vẫn deterministic và sẽ được re-embed khi event mới đến.
  if (!data.semanticContent || typeof data.semanticContent !== "object") {
    data.semanticContent = {
      title: String(data.name).slice(0, 255),
      shortDescription: null,
      description: null,
      brandName: null,
      categoryPath: null,
      attributes: [],
      contentHash: `legacy:${String(data.productId)}:${catalogVersion}`,
    };
  }
  const semanticContent = data.semanticContent as Record<string, unknown>;
  requireString(semanticContent.title, "data.semanticContent.title", 255);
  for (const field of ["shortDescription", "description", "brandName", "categoryPath"] as const) {
    if (semanticContent[field] !== null && semanticContent[field] !== undefined) {
      requireString(semanticContent[field], `data.semanticContent.${field}`, field === "description" ? 4000 : 1000);
    }
  }
  requireString(semanticContent.contentHash, "data.semanticContent.contentHash", 128);
  if (!Array.isArray(semanticContent.attributes) || semanticContent.attributes.length > 50) {
    throw new InvalidKafkaEventError("data.semanticContent.attributes must contain at most 50 items");
  }
  for (const [index, attributeValue] of semanticContent.attributes.entries()) {
    if (!attributeValue || typeof attributeValue !== "object" || Array.isArray(attributeValue)) {
      throw new InvalidKafkaEventError(`data.semanticContent.attributes[${index}] must be an object`);
    }
    const attribute = attributeValue as Record<string, unknown>;
    requireString(attribute.key, `data.semanticContent.attributes[${index}].key`, 128);
    requireString(attribute.value, `data.semanticContent.attributes[${index}].value`, 500);
  }
  data.catalogRevision = catalogVersion;
  data.catalogVersion = catalogVersion;
  requireIsoDate(data.createdAt, "data.createdAt");
  requireIsoDate(data.updatedAt, "data.updatedAt");
  return event as unknown as RecommendationCatalogEvent;
}

// Validate purchase/return snapshot để profile projection chỉ nhận user, item và quantity tối thiểu.
export function validatePurchaseEvent(
  input: unknown,
): RecommendationPurchaseEvent {
  const event = requireEnvelope(input, purchaseEventNames);
  const data = event.data as Record<string, unknown>;
  requireString(data.orderId, "data.orderId", 128);
  requireString(data.customerUserId, "data.customerUserId", 128);
  requireIsoDate(data.occurredAt, "data.occurredAt");
  if (
    !Array.isArray(data.items) ||
    data.items.length === 0 ||
    data.items.length > 200
  ) {
    throw new InvalidKafkaEventError(
      "data.items must contain between 1 and 200 items",
    );
  }
  for (const [index, itemValue] of data.items.entries()) {
    if (
      !itemValue ||
      typeof itemValue !== "object" ||
      Array.isArray(itemValue)
    ) {
      throw new InvalidKafkaEventError(
        `data.items[${index}] must be an object`,
      );
    }
    const item = itemValue as Record<string, unknown>;
    requireString(item.orderItemId, `data.items[${index}].orderItemId`, 128);
    requireString(item.productId, `data.items[${index}].productId`, 128);
    if (item.variantId !== null && item.variantId !== undefined) {
      requireString(item.variantId, `data.items[${index}].variantId`, 128);
    }
    if (item.categoryId !== null && item.categoryId !== undefined) {
      requireString(item.categoryId, `data.items[${index}].categoryId`, 128);
    }
    if (
      typeof item.quantity !== "number" ||
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 10000
    ) {
      throw new InvalidKafkaEventError(
        `data.items[${index}].quantity must be a positive integer`,
      );
    }
  }
  return event as unknown as RecommendationPurchaseEvent;
}
