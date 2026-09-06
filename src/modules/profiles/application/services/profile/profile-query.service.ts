// Service này cung cấp profile data cho ranking và điều phối guest-to-user merge mà không biết persistence details.

import { Injectable } from "@nestjs/common";
import { RecommendationRedisService } from "../../../../../infrastructure/redis/redis.module";
import { SessionContextService } from "../session/session-context.service";
import type { PreferenceValue } from "../../types/profile.types";
import { ProfileQueryRepository } from "../../../infrastructure/repositories/profile-query.repository";

// Application service giữ boundary giữa recommendation use case và profile persistence/cache.
@Injectable()
export class ProfileQueryService {
  constructor(
    private readonly repository: ProfileQueryRepository,
    private readonly redis: RecommendationRedisService,
    private readonly sessionContext: SessionContextService,
  ) {}

  // Lấy top preference theo dimension để candidate engine không cần biết schema database.
  async getTop(
    actorType: "USER" | "SESSION",
    actorId: string,
    dimension: string,
    limit = 12,
  ): Promise<PreferenceValue[]> {
    return this.repository.findTop(actorType, actorId, dimension, limit);
  }

  // Merge guest profile qua repository transaction rồi dọn Redis sau khi persistence hoàn tất.
  async mergeGuestSession(
    userId: string,
    sessionId: string,
  ): Promise<{ merged: boolean }> {
    const merged = await this.repository.mergeGuestSession(userId, sessionId);
    await this.sessionContext.invalidate(sessionId);
    await this.redis.invalidateActor("user", userId);
    return { merged };
  }
}
