// Các type này mô tả profile read model và session context, không expose TypeORM entity ra controller.

import type { RecommendationActorType } from "../../../../database/profiles/entities/actor-profile.entity";
import type { RecommendationPreferenceDimension } from "../../../../database/profiles/entities/actor-preference.entity";

export interface PreferenceValue {
  actorType: RecommendationActorType;
  actorId: string;
  dimension: RecommendationPreferenceDimension;
  dimensionKey: string;
  score: number;
  interactionCount: number;
  lastSignalAt: Date;
}

export interface SessionContext {
  sessionId: string;
  recentProductIds: string[];
  recentCategoryIds: string[];
  recentBrandIds: string[];
  currentProductId: string | null;
  currentCategoryId: string | null;
  latestQuery: string | null;
  cartProductIds: string[];
  intentUpdatedAt: string;
  version: number;
}
