import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { RecommendationInteractionEntity } from "../../database/interactions/entities/interaction.entity";
import { RecommendationProductRelationEntity } from "../../database/relations/entities/product-relation.entity";
import { RecommendationRelationProjectionEventEntity } from "../../database/relations/entities/relation-projection-event.entity";
import { RelationRepository } from "./infrastructure/repositories/relation.repository";
import { RelationProjectionService } from "./application/services/projection/relation-projection.service";
import { RelationCandidateService } from "./application/services/candidates/relation-candidate.service";
import { RelationConsumerService } from "../../kafka/consumers/relation-consumer.service";

// Bounded context relations sở hữu projection và query adapter, không phụ thuộc Product/Order database.
@Module({
  imports: [
    TypeOrmModule.forFeature([
      RecommendationInteractionEntity,
      RecommendationProductRelationEntity,
      RecommendationRelationProjectionEventEntity,
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
