// Module này cung cấp recommendation query từ catalog/profile read models; không sở hữu Product master hoặc transaction checkout.

import { Module } from "@nestjs/common";
import { CatalogModule } from "../catalog/catalog.module";
import { ProfilesModule } from "../profiles/profiles.module";
import { RecommendationController } from "./presentation/controllers/recommendation.controller";
import { RecommendationQueryService } from "./application/services/query/recommendation-query.service";
import { RecommendationRankingService } from "./application/services/ranking/policy/recommendation-ranking.service";
import { SemanticCandidateService } from "./application/services/candidates/sources/semantic-candidate.service";
import { RelationsModule } from "../relations/relations.module";
import { CandidateUnionService } from "./application/services/candidates/union/candidate-union.service";
import { CandidateGenerationService } from "./application/services/candidates/generation/candidate-generation.service";
import { RankingFeatureService } from "./application/services/ranking/features/ranking-feature.service";
import { RankingExperimentService } from "./application/services/ranking/experiments/ranking-experiment.service";
import { RecommendationTrackingTokenService } from "./application/services/tracking/attribution/recommendation-tracking-token.service";

@Module({
  imports: [CatalogModule, ProfilesModule, RelationsModule],
  controllers: [RecommendationController],
  providers: [
    RecommendationQueryService,
    RecommendationRankingService,
    SemanticCandidateService,
    CandidateUnionService,
    CandidateGenerationService,
    RankingFeatureService,
    RankingExperimentService,
    RecommendationTrackingTokenService,
  ],
  exports: [RecommendationTrackingTokenService],
})
export class RecommendationModule {}
