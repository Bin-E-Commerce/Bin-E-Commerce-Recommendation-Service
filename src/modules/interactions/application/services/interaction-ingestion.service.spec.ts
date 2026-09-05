// Test này khóa trust boundary: identity trong request header được dùng, còn body không có userId để giả mạo.
/// <reference types="jest" />
import type { Request } from "express";
import { InteractionIngestionService } from "./interaction-ingestion.service";

describe("InteractionIngestionService", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  // User đã xác thực phải được đưa vào envelope cùng request correlation để trace event xuyên service.
  it("publishes an authenticated interaction with trusted headers", async () => {
    // Arrange
    const kafkaProducer = { publish: jest.fn().mockResolvedValue(undefined) };
    const service = new InteractionIngestionService(kafkaProducer as never);
    const request = {
      headers: {
        "x-user-id": "user-1",
        "x-session-id": "session-1",
        "x-request-id": "request-1",
      },
    } as unknown as Request;

    // Act
    const result = await service.record(
      { interactionType: "PRODUCT_VIEWED", productId: "product-1" },
      request,
    );

    // Assert
    expect(result.eventId).toEqual(expect.any(String));
    expect(kafkaProducer.publish).toHaveBeenCalledWith(
      "recommendation.interactions.v1",
      "user-1",
      expect.objectContaining({
        aggregateId: "user-1",
        metadata: { correlationId: "request-1", actorUserId: "user-1" },
        data: expect.objectContaining({
          userId: "user-1",
          productId: "product-1",
        }),
      }),
    );
  });

  // Guest không có session UUID hợp lệ phải bị từ chối trước khi tạo Kafka message.
  it("rejects a guest request without a UUID v4 session", async () => {
    // Arrange
    const kafkaProducer = { publish: jest.fn() };
    const service = new InteractionIngestionService(kafkaProducer as never);
    const request = {
      headers: { "x-session-id": "guest-session" },
    } as unknown as Request;

    // Act / Assert
    await expect(
      service.record(
        { interactionType: "PRODUCT_VIEWED", productId: "product-1" },
        request,
      ),
    ).rejects.toThrow("A valid user or guest session is required");
    expect(kafkaProducer.publish).not.toHaveBeenCalled();
  });
});
