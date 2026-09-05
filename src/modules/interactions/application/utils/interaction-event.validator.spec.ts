// Test này khóa contract validation để malformed event không được ghi vào interaction read model.

import { RecommendationEvents } from "../../../../../../../packages/common/kafka/events/recommendation.events";
import { InvalidInteractionEventError } from "../errors/invalid-interaction-event.error";
import { validateInteractionEvent } from "./interaction-event.validator";

describe("validateInteractionEvent", () => {
  // Tạo event hợp lệ tối thiểu, dùng session thay cho user để kiểm tra anonymous flow.
  function createValidEvent() {
    return {
      eventId: "event-1",
      eventName: RecommendationEvents.INTERACTION_RECORDED,
      eventVersion: 1,
      source: "api-gateway",
      occurredAt: "2026-09-04T10:00:00.000Z",
      aggregateId: "session-1",
      data: {
        interactionType: "PRODUCT_VIEWED",
        userId: null,
        sessionId: "session-1",
        productId: "product-1",
        variantId: null,
        categoryId: null,
        query: null,
        page: "product_detail",
        position: null,
        quantity: null,
        requestId: "request-1",
      },
    };
  }

  // Event đúng contract phải được chuẩn hóa thành read model input.
  it("accepts a valid anonymous product event", () => {
    // Arrange
    const event = createValidEvent();

    // Act
    const result = validateInteractionEvent(event);

    // Assert
    expect(result.data.interactionType).toBe("PRODUCT_VIEWED");
    expect(result.data.sessionId).toBe("session-1");
  });

  // Event không có actor phải bị chặn để không tạo interaction không thể gắn vào user/session.
  it("rejects an event without an actor", () => {
    // Arrange
    const event = createValidEvent();
    event.data.userId = null;
    Object.assign(event.data, { sessionId: null });

    // Act / Assert
    expect(() => validateInteractionEvent(event)).toThrow(
      InvalidInteractionEventError,
    );
  });

  // Event search thiếu query phải bị chặn vì không mang giá trị intent cho pipeline sau này.
  it("requires a query for search events", () => {
    // Arrange
    const event = createValidEvent();
    Object.assign(event.data, {
      interactionType: "SEARCH_PERFORMED",
      productId: null,
    });

    // Act / Assert
    expect(() => validateInteractionEvent(event)).toThrow(
      "query is required for search interaction",
    );
  });
});
