import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RecommendationProductRelationEntity } from '@/database/relations/entities/product-relation.entity';
import { RecommendationRelationProjectionEventEntity } from '@/database/relations/entities/relation-projection-event.entity';
import { RecommendationRelationSignalEntity } from '@/database/relations/entities/relation-signal.entity';
import { RecommendationRelationPairEventEntity } from '@/database/relations/entities/relation-pair-event.entity';
import { RelationRepository } from '@/modules/relations/infrastructure/repositories/relation.repository';
import { RelationProjectionService } from '@/modules/relations/application/services/projection/relation-projection.service';
import { RelationCandidateService } from '@/modules/relations/application/services/candidates/relation-candidate.service';
import { RelationConsumerService } from '@/kafka/consumers/relations/relation-consumer.service';
import { ProfilesModule } from '@/modules/profiles/profiles.module';

// Bounded context relations sở hữu projection và query adapter, không phụ thuộc Product/Order database.
@Module({
    imports: [
        // Dùng RecommendationRuleService từ ProfilesModule để projection và profile áp dụng cùng một policy.
        ProfilesModule,
        TypeOrmModule.forFeature([
            RecommendationProductRelationEntity,
            RecommendationRelationProjectionEventEntity,
            RecommendationRelationSignalEntity,
            RecommendationRelationPairEventEntity,
        ]),
    ],
    providers: [
        RelationRepository,
        RelationProjectionService,
        RelationCandidateService,
        RelationConsumerService,
    ],
    exports: [
        RelationCandidateService,
        RelationProjectionService,
        RelationRepository,
    ],
})
export class RelationsModule {}
