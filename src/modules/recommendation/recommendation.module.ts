// Module này cung cấp recommendation query từ catalog/profile read models; không sở hữu Product master hoặc transaction checkout.

import { Module } from "@nestjs/common";
import { CatalogModule } from "../catalog/catalog.module";
import { ProfilesModule } from "../profiles/profiles.module";
import { RecommendationController } from "./presentation/controllers/recommendation.controller";
import { RecommendationQueryService } from "./application/services/recommendation-query.service";
import { RecommendationRankingService } from "./application/services/recommendation-ranking.service";

@Module({
  imports: [CatalogModule, ProfilesModule],
  controllers: [RecommendationController],
  providers: [RecommendationQueryService, RecommendationRankingService],
})
export class RecommendationModule {}
