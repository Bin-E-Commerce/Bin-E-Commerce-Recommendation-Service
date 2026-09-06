// Repository này đọc preference và thực hiện persistence của guest-to-user merge; cache/session vẫn do application service quản lý.

import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import { RecommendationActorPreferenceEntity } from "../../../../database/profiles/entities/actor-preference.entity";
import { RecommendationActorProfileEntity } from "../../../../database/profiles/entities/actor-profile.entity";
import type { PreferenceValue } from "../../application/types/profile.types";

// Adapter persistence cho các query profile phục vụ ranking và guest merge.
@Injectable()
export class ProfileQueryRepository {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(RecommendationActorPreferenceEntity)
    private readonly preferenceRepository: Repository<RecommendationActorPreferenceEntity>,
  ) {}

  // Lấy top preference theo actor/dimension để ranking không phụ thuộc TypeORM schema.
  async findTop(
    actorType: "USER" | "SESSION",
    actorId: string,
    dimension: string,
    limit = 12,
  ): Promise<PreferenceValue[]> {
    return this.preferenceRepository.find({
      where: { actorType, actorId, dimension: dimension as never },
      order: { score: "DESC", lastSignalAt: "DESC" },
      take: Math.min(limit, 50),
    }) as unknown as PreferenceValue[];
  }

  // Merge toàn bộ preference guest trong transaction và trả false nếu session không tồn tại hoặc đã merge.
  async mergeGuestSession(userId: string, sessionId: string): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      // Advisory lock bảo vệ cặp user/session khỏi hai request login chạy đồng thời.
      await manager.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`recommendation-merge:${userId}:${sessionId}`],
      );

      const guest = await manager.findOne(RecommendationActorProfileEntity, {
        where: { actorType: "SESSION", actorId: sessionId },
      });
      if (!guest || guest.mergedAt) return false;

      const guestPreferences = await manager.find(RecommendationActorPreferenceEntity, {
        where: { actorType: "SESSION", actorId: sessionId },
      });
      for (const preference of guestPreferences) {
        await manager.query(
          `INSERT INTO recommendation_actor_preferences (actor_type, actor_id, dimension, dimension_key, score, interaction_count, last_signal_at)
           VALUES ('USER', $1, $2, $3, $4, $5, $6)
           ON CONFLICT (actor_type, actor_id, dimension, dimension_key)
           DO UPDATE SET score = recommendation_actor_preferences.score + EXCLUDED.score,
                         interaction_count = recommendation_actor_preferences.interaction_count + EXCLUDED.interaction_count,
                         last_signal_at = GREATEST(recommendation_actor_preferences.last_signal_at, EXCLUDED.last_signal_at),
                         updated_at = now()`,
          [
            userId,
            preference.dimension,
            preference.dimensionKey,
            preference.score,
            preference.interactionCount,
            preference.lastSignalAt,
          ],
        );
      }

      await manager.query(
        `INSERT INTO recommendation_actor_profiles (actor_type, actor_id, last_interaction_at, profile_version)
         VALUES ('USER', $1, $2, 1)
         ON CONFLICT (actor_type, actor_id)
         DO UPDATE SET last_interaction_at = GREATEST(COALESCE(recommendation_actor_profiles.last_interaction_at, EXCLUDED.last_interaction_at), EXCLUDED.last_interaction_at),
                       profile_version = recommendation_actor_profiles.profile_version + 1,
                       updated_at = now()`,
        [userId, guest.lastInteractionAt],
      );

      await manager.update(
        RecommendationActorProfileEntity,
        { id: guest.id },
        { mergedAt: new Date() },
      );
      return true;
    });
  }
}
