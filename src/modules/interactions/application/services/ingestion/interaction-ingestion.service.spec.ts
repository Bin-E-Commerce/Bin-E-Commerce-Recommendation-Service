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
    const trackingToken = { verify: jest.fn() };
    const service = new InteractionIngestionService(
      kafkaProducer as never,
      trackingToken as never,
    );
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
    const trackingToken = { verify: jest.fn() };
    const service = new InteractionIngestionService(
      kafkaProducer as never,
      trackingToken as never,
    );
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

  it("publishes only verified recommendation attribution", async () => {
    // Arrange
    const kafkaProducer = { publish: jest.fn().mockResolvedValue(undefined) };
    const trackingToken = {
      verify: jest.fn().mockReturnValue(true),
    };
    const service = new InteractionIngestionService(
      kafkaProducer as never,
      trackingToken as never,
    );
    const request = {
      headers: {
        "x-user-id": "user-1",
      },
    } as unknown as Request;
    const dto = {
      interactionType: "PRODUCT_CLICKED",
      productId: "product-1",
      recommendationRequestId: "request-1",
      recommendationItemId: "signed-item-token",
      recommendationSource: "SEMANTIC_SIMILARITY",
      recommendationRank: 1,
      surface: "home" as const,
      recommendationPolicyVersion: "hybrid-ranking-v1",
      recommendationExperimentId: "phase4-test",
      recommendationExperimentVariant: "HYBRID" as const,
    };

    // Act
    await service.record(dto, request);

    // Assert
    expect(trackingToken.verify).toHaveBeenCalledWith(
      "signed-item-token",
      expect.objectContaining({
        actorId: "user-1",
        requestId: "request-1",
        productId: "product-1",
        rank: 1,
        source: "SEMANTIC_SIMILARITY",
      }),
    );
    expect(kafkaProducer.publish).toHaveBeenCalledWith(
      "recommendation.interactions.v1",
      "user-1",
      expect.objectContaining({
        data: expect.objectContaining({
          recommendationItemId: "signed-item-token",
          recommendationExperimentVariant: "HYBRID",
        }),
      }),
    );
  });

  it("rejects forged recommendation attribution before publishing", async () => {
    // Arrange
    const kafkaProducer = { publish: jest.fn() };
    const trackingToken = {
      verify: jest.fn().mockReturnValue(false),
    };
    const service = new InteractionIngestionService(
      kafkaProducer as never,
      trackingToken as never,
    );
    const request = {
      headers: {
        "x-user-id": "user-1",
      },
    } as unknown as Request;

    // Act / Assert
    await expect(
      service.record(
        {
          interactionType: "PRODUCT_CLICKED",
          productId: "product-1",
          recommendationRequestId: "request-1",
          recommendationItemId: "forged-token",
          recommendationSource: "TRENDING",
          recommendationRank: 1,
          surface: "home",
          recommendationPolicyVersion: "hybrid-ranking-v1",
        },
        request,
      ),
    ).rejects.toThrow("Invalid recommendation attribution");
    expect(kafkaProducer.publish).not.toHaveBeenCalled();
  });
});
