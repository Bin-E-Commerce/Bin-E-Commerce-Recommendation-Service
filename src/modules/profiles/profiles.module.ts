// Module này sở hữu profile dài hạn, session intent và projection rules; recommendation chỉ đọc qua application services.

import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { RecommendationActorProfileEntity } from "../../database/profiles/entities/actor-profile.entity";
import { RecommendationActorPreferenceEntity } from "../../database/profiles/entities/actor-preference.entity";
import { RecommendationPopularityEntity } from "../../database/popularity/entities/popularity.entity";
import { RecommendationPopularityDailyEntity } from "../../database/popularity/entities/popularity-daily.entity";
import { RecommendationProjectionEventEntity } from "../../database/profiles/entities/projection-event.entity";
import { CatalogModule } from "../catalog/catalog.module";
import { ProfileProjectionService } from "./application/services/profile/profile-projection.service";
import { ProfileQueryService } from "./application/services/profile/profile-query.service";
import { SessionContextService } from "./application/services/session/session-context.service";
import { PopularityService } from "./application/services/popularity/popularity.service";
import { RecommendationRuleService } from "./application/services/rules/recommendation-rule.service";
import { PopularityRepository } from "./infrastructure/repositories/popularity.repository";
import { ProfileProjectionRepository } from "./infrastructure/repositories/profile-projection.repository";
import { ProfileQueryRepository } from "./infrastructure/repositories/profile-query.repository";

@Module({
  imports: [
    CatalogModule,
    TypeOrmModule.forFeature([
      RecommendationActorProfileEntity,
      RecommendationActorPreferenceEntity,
      RecommendationPopularityEntity,
      RecommendationPopularityDailyEntity,
      RecommendationProjectionEventEntity,
    ]),
  ],
  providers: [
    ProfileProjectionRepository,
    ProfileQueryRepository,
    PopularityRepository,
    ProfileProjectionService,
    ProfileQueryService,
    SessionContextService,
    PopularityService,
    RecommendationRuleService,
  ],
  exports: [
    ProfileProjectionService,
    ProfileQueryService,
    SessionContextService,
    PopularityService,
    RecommendationRuleService,
  ],
})
export class ProfilesModule {}
