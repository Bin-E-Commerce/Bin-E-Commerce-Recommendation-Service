// Test này kiểm tra retry và DLQ boundary mà không cần khởi động Kafka thật.
/// <reference types="jest" />
import { InvalidInteractionEventError } from "../../../modules/interactions/application/errors/invalid-interaction-event.error";
import { InteractionMessageProcessor } from "./interaction-message.processor";

describe("InteractionMessageProcessor", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  // Processor phải đưa malformed event vào DLQ ngay, không retry payload không thể sửa.
  it("moves invalid events to the DLQ without retrying", async () => {
    // Arrange
    const processingService = {
      process: jest
        .fn()
        .mockRejectedValue(new InvalidInteractionEventError("invalid event")),
    };
    const kafkaProducer = { publish: jest.fn().mockResolvedValue(undefined) };
    const processor = new InteractionMessageProcessor(
      processingService as never,
      kafkaProducer as never,
    );

    // Act
    await processor.process(JSON.stringify({ eventId: "event-1" }));

    // Assert
    expect(processingService.process).toHaveBeenCalledTimes(1);
    expect(kafkaProducer.publish).toHaveBeenCalledWith(
      "recommendation.interactions.dlq.v1",
      "event-1",
      expect.objectContaining({ reason: "invalid event" }),
    );
  });

  // Lỗi persistence tạm thời phải được retry đủ ba lần trước khi chuyển DLQ.
  it("retries infrastructure failures before moving to the DLQ", async () => {
    // Arrange
    const processingService = {
      process: jest.fn().mockRejectedValue(new Error("database unavailable")),
    };
    const kafkaProducer = { publish: jest.fn().mockResolvedValue(undefined) };
    const processor = new InteractionMessageProcessor(
      processingService as never,
      kafkaProducer as never,
    );

    // Act
    await processor.process(
      JSON.stringify({
        eventId: "event-2",
        eventName: "recommendation.interaction.recorded",
        data: {},
      }),
    );

    // Assert
    expect(processingService.process).toHaveBeenCalledTimes(3);
    expect(kafkaProducer.publish).toHaveBeenCalledTimes(1);
  });
});
