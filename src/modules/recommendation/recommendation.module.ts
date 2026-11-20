// Module này cung cấp recommendation query từ catalog/profile read models; không sở hữu Product master hoặc transaction checkout.

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RecommendationTrainingSnapshotEntity } from '@/database/recommendations/entities/recommendation-training-snapshot.entity';
import { CatalogModule } from '@/modules/catalog/catalog.module';
import { ProfilesModule } from '@/modules/profiles/profiles.module';
import { RecommendationController } from '@/modules/recommendation/presentation/controllers/recommendation.controller';
import { RecommendationQueryService } from '@/modules/recommendation/application/services/query/recommendation-query.service';
import { RecommendationRankingService } from '@/modules/recommendation/application/services/ranking/policy/recommendation-ranking.service';
import { SemanticCandidateService } from '@/modules/recommendation/application/services/candidates/sources/semantic-candidate.service';
import { RelationsModule } from '@/modules/relations/relations.module';
import { CandidateUnionService } from '@/modules/recommendation/application/services/candidates/union/candidate-union.service';
import { CandidateGenerationService } from '@/modules/recommendation/application/services/candidates/generation/candidate-generation.service';
import { RankingFeatureService } from '@/modules/recommendation/application/services/ranking/features/ranking-feature.service';
import { RecommendationTrackingTokenService } from '@/modules/recommendation/application/services/tracking/attribution/recommendation-tracking-token.service';
import { RecommendationMlRankingService } from '@/modules/recommendation/application/services/ranking/ml/recommendation-ml-ranking.service';
import { RankingSimulationService } from '@/modules/recommendation/application/services/offline/ranking-simulation.service';
import { RECOMMENDATION_TRAINING_SNAPSHOT_WRITER } from '@/modules/recommendation/application/types/recommendation-training-snapshot.types';
import { RecommendationTrainingSnapshotRepository } from '@/modules/recommendation/infrastructure/repositories/recommendation-training-snapshot.repository';

@Module({
    imports: [
        CatalogModule,
        ProfilesModule,
        RelationsModule,
        TypeOrmModule.forFeature([RecommendationTrainingSnapshotEntity]),
    ],
    controllers: [RecommendationController],
    providers: [
        RecommendationQueryService,
        RecommendationRankingService,
        SemanticCandidateService,
        CandidateUnionService,
        CandidateGenerationService,
        RankingFeatureService,
        RecommendationTrackingTokenService,
        RecommendationMlRankingService,
        RankingSimulationService,
        RecommendationTrainingSnapshotRepository,
        {
            provide: RECOMMENDATION_TRAINING_SNAPSHOT_WRITER,
            useExisting: RecommendationTrainingSnapshotRepository,
        },
    ],
    exports: [
        RecommendationTrackingTokenService,
        RecommendationMlRankingService,
    ],
})
// Module kết nối writer persistence vào query service mà không đưa TypeORM vào application layer.
export class RecommendationModule {}
