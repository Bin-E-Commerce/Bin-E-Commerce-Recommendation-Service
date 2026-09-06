// Unit tests bảo vệ schema boundary của catalog/purchase event trước khi Kafka processor retry hoặc projection.

import {
  validateCatalogEvent,
  validatePurchaseEvent,
} from "./event.validators";

describe("event validators", () => {
  it("should accept a valid catalog event", () => {
    // Arrange
    const event = {
      eventId: "catalog-event-1",
      eventName: "product.catalog.upserted",
      eventVersion: 1,
      source: "product-service",
      aggregateId: "product-1",
      occurredAt: "2026-09-06T10:00:00.000Z",
      data: {
        productId: "product-1",
        originType: "INTERNAL",
        name: "Product",
        slug: "product",
        status: "ACTIVE",
        isInStock: true,
        catalogVersion: 2,
        createdAt: "2026-09-01T10:00:00.000Z",
        updatedAt: "2026-09-06T10:00:00.000Z",
      },
    };

    // Act
    const result = validateCatalogEvent(event);

    // Assert
    expect(result.data.productId).toBe("product-1");
    expect(result.eventVersion).toBe(1);
  });

  it("should reject a catalog event with an invalid stock flag", () => {
    // Arrange
    const event = {
      eventId: "catalog-event-1",
      eventName: "product.catalog.upserted",
      eventVersion: 1,
      source: "product-service",
      aggregateId: "product-1",
      occurredAt: "2026-09-06T10:00:00.000Z",
      data: {
        productId: "product-1",
        originType: "INTERNAL",
        name: "Product",
        slug: "product",
        status: "ACTIVE",
        isInStock: "true",
        catalogVersion: 2,
        createdAt: "2026-09-01T10:00:00.000Z",
        updatedAt: "2026-09-06T10:00:00.000Z",
      },
    };

    // Act & Assert
    expect(() => validateCatalogEvent(event)).toThrow("data.isInStock must be boolean");
  });

  it("should reject a purchase event without items", () => {
    // Arrange
    const event = {
      eventId: "purchase-event-1",
      eventName: "order.purchase.completed",
      eventVersion: 1,
      source: "order-service",
      aggregateId: "order-1",
      occurredAt: "2026-09-06T10:00:00.000Z",
      data: {
        orderId: "order-1",
        customerUserId: "user-1",
        occurredAt: "2026-09-06T10:00:00.000Z",
        items: [],
      },
    };

    // Act & Assert
    expect(() => validatePurchaseEvent(event)).toThrow(
      "data.items must contain between 1 and 200 items",
    );
  });
});
