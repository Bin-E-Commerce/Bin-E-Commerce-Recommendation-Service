// Service này cung cấp profile data cho ranking và điều phối guest-to-user merge mà không biết persistence details.

import { Injectable } from "@nestjs/common";
import { RecommendationRedisService } from "../../../../../infrastructure/redis/redis.module";
import { SessionContextService } from "../session/session-context.service";
import type { PreferenceValue } from "../../types/profile.types";
import { ProfileQueryRepository } from "../../../infrastructure/repositories/profile-query.repository";
import { RecommendationRuleService } from "../rules/recommendation-rule.service";

// Application service giữ boundary giữa recommendation use case và profile persistence/cache.
@Injectable()
export class ProfileQueryService {
  constructor(
    private readonly repository: ProfileQueryRepository,
    private readonly redis: RecommendationRedisService,
    private readonly sessionContext: SessionContextService,
    private readonly rules: RecommendationRuleService,
  ) {}

  // Lấy top positive và negative preference riêng theo dimension để return/refund mạnh
  // không đẩy hết tín hiệu tích cực ra khỏi feature set của ranker.
  async getTop(
    actorType: "USER" | "SESSION",
    actorId: string,
    dimension: string,
    limit = 12,
  ): Promise<PreferenceValue[]> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 50);
    const values = await this.repository.findTop(
      actorType,
      actorId,
      dimension,
      Math.max(safeLimit * 5, 50),
    );
    const now = Date.now();
    const halfLife = this.rules.getProfileHalfLifeDays();
    const sortByEffectiveMagnitude = (
      left: PreferenceValue,
      right: PreferenceValue,
    ): number => {
      const leftScore = Math.abs(this.effectiveScore(left, now, halfLife));
      const rightScore = Math.abs(this.effectiveScore(right, now, halfLife));
      return (
        rightScore - leftScore ||
        right.lastSignalAt.getTime() - left.lastSignalAt.getTime() ||
        left.dimensionKey.localeCompare(right.dimensionKey)
      );
    };
    const positive = values
      .filter((value) => this.effectiveScore(value, now, halfLife) > 0)
      .sort(sortByEffectiveMagnitude)
      .slice(0, safeLimit);
    const negative = values
      .filter((value) => this.effectiveScore(value, now, halfLife) < 0)
      .sort(sortByEffectiveMagnitude)
      .slice(0, safeLimit);
    return [...positive, ...negative];
  }

  // Sort theo score sau decay và giữ negative signal mạnh để ranker không bị preference cũ lấn át.
  private effectiveScore(
    value: PreferenceValue,
    now: number,
    halfLife: number,
  ): number {
    const ageDays = Math.max(
      0,
      (now - value.lastSignalAt.getTime()) / 86_400_000,
    );
    return value.score * Math.pow(0.5, ageDays / halfLife);
  }

  // Merge guest profile qua repository transaction rồi dọn Redis sau khi persistence hoàn tất.
  async mergeGuestSession(
    userId: string,
    sessionId: string,
  ): Promise<{ merged: boolean }> {
    const context = await this.sessionContext.get(sessionId);
    const merged = await this.repository.mergeGuestSession(
      userId,
      sessionId,
      context ?? undefined,
    );
    // Chỉ xóa session sau khi transaction durable thành công; nếu chưa merge thì giữ context để retry không mất hành vi.
    if (merged) {
      await this.sessionContext.invalidate(sessionId);
      await this.redis.invalidateActor("user", userId);
    }
    return { merged };
  }
}
