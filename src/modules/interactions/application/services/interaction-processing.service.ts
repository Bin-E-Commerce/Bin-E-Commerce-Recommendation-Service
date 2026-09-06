// Application service này validate event Kafka rồi lưu interaction; đây là điểm mở rộng cho profile ở Phase 2.

import { Injectable, Logger } from "@nestjs/common";
import { RecommendationInteractionRepository } from "../../infrastructure/repositories/recommendation-interaction.repository";
import { validateInteractionEvent } from "../utils/interaction-event.validator";
import { ProfileProjectionService } from "../../../profiles/application/services/profile/profile-projection.service";

@Injectable()
export class InteractionProcessingService {
  private readonly logger = new Logger(InteractionProcessingService.name);

  // Repository được inject qua port adapter để business flow không phụ thuộc controller hay Kafka client.
  constructor(
    private readonly interactionRepository: RecommendationInteractionRepository,
    private readonly profileProjection: ProfileProjectionService,
  ) {}

  // Parse, validate và persist một event; duplicate là trạng thái thành công do Kafka có thể redeliver.
  async process(input: unknown): Promise<"inserted" | "duplicate"> {
    const event = validateInteractionEvent(input);
    const result = await this.interactionRepository.insertIfNotExists(event);

    // Project cả event duplicate để trường hợp lần xử lý trước đã lưu interaction nhưng projection bị lỗi vẫn được retry an toàn.
    await this.profileProjection.project(event);

    if (result === "duplicate") {
      this.logger.debug(`Skipped duplicate interaction ${event.eventId}`);
    } else {
      this.logger.debug(`Stored interaction ${event.eventId}`);
    }

    return result;
  }
}
