// Repository này ghi profile projection trong transaction; application service chỉ quyết định actor và weight cần áp dụng.

import { Injectable } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import type { RecommendationActorType } from "../../../../database/profiles/entities/actor-profile.entity";
import type { RecommendationPreferenceDimension } from "../../../../database/profiles/entities/actor-preference.entity";

export interface PreferenceUpsertInput {
  actorType: RecommendationActorType;
  actorId: string;
  dimension: RecommendationPreferenceDimension;
  dimensionKey: string;
  score: number;
  occurredAt: Date;
}

// Adapter transaction cho actor profile, preference và projection ledger.
@Injectable()
export class ProfileProjectionRepository {
  constructor(private readonly dataSource: DataSource) {}

  // Mở transaction dùng chung cho profile và popularity để mọi tín hiệu được commit/rollback cùng nhau.
  async transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(work);
  }

  // Claim event một lần; false nghĩa là Kafka redelivery và caller phải bỏ qua phần cộng điểm.
  async claimProjectionEvent(eventId: string, manager: EntityManager): Promise<boolean> {
    const inserted = await manager.query(
      `INSERT INTO recommendation_projection_events (event_id)
       VALUES ($1)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [eventId],
    );
    return inserted.length > 0;
  }

  // Upsert actor profile và chỉ nhận lastInteractionAt mới hơn để event đến trễ không lùi trạng thái profile.
  async upsertActorProfile(
    actorType: RecommendationActorType,
    actorId: string,
    lastInteractionAt: Date,
    manager: EntityManager,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO recommendation_actor_profiles (actor_type, actor_id, last_interaction_at, profile_version)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (actor_type, actor_id)
       DO UPDATE SET last_interaction_at = GREATEST(COALESCE(recommendation_actor_profiles.last_interaction_at, EXCLUDED.last_interaction_at), EXCLUDED.last_interaction_at),
                     profile_version = recommendation_actor_profiles.profile_version + 1,
                     updated_at = now()`,
      [actorType, actorId, lastInteractionAt],
    );
  }

  // Cộng điểm preference theo unique dimension key và giữ nguyên mốc tín hiệu mới nhất.
  async upsertPreference(input: PreferenceUpsertInput, manager: EntityManager): Promise<void> {
    await manager.query(
      `INSERT INTO recommendation_actor_preferences (actor_type, actor_id, dimension, dimension_key, score, interaction_count, last_signal_at)
       VALUES ($1, $2, $3, $4, $5, 1, $6)
       ON CONFLICT (actor_type, actor_id, dimension, dimension_key)
       DO UPDATE SET score = recommendation_actor_preferences.score + EXCLUDED.score,
                     interaction_count = recommendation_actor_preferences.interaction_count + 1,
                     last_signal_at = GREATEST(recommendation_actor_preferences.last_signal_at, EXCLUDED.last_signal_at),
                     updated_at = now()`,
      [
        input.actorType,
        input.actorId,
        input.dimension,
        input.dimensionKey,
        input.score,
        input.occurredAt,
      ],
    );
  }
}
