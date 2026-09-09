// Module này cung cấp recommendation query từ catalog/profile read models; không sở hữu Product master hoặc transaction checkout.

import { Module } from "@nestjs/common";
import { CatalogModule } from "../catalog/catalog.module";
import { ProfilesModule } from "../profiles/profiles.module";
import { RecommendationController } from "./presentation/controllers/recommendation.controller";
import { RecommendationQueryService } from "./application/services/query/recommendation-query.service";
import { RecommendationRankingService } from "./application/services/ranking/recommendation-ranking.service";
import { SemanticCandidateService } from "./application/services/candidates/semantic-candidate.service";
import { RelationsModule } from "../relations/relations.module";
import { CandidateUnionService } from "./application/services/candidates/candidate-union.service";
import { CandidateGenerationService } from "./application/services/candidates/candidate-generation.service";

@Module({
  imports: [CatalogModule, ProfilesModule, RelationsModule],
  controllers: [RecommendationController],
  providers: [
    RecommendationQueryService,
    RecommendationRankingService,
    SemanticCandidateService,
    CandidateUnionService,
    CandidateGenerationService,
  ],
})
export class RecommendationModule {}
