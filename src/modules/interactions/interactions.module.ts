// Module này đóng gói toàn bộ Phase 1 interaction flow: HTTP ingestion, Kafka processing và PostgreSQL read model.

import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { KafkaModule } from "../../kafka/kafka.module";
import { KafkaConsumerService } from "../../kafka/consumers/kafka-consumer.service";
import { RecommendationInteractionEntity } from "../../database/entities/recommendation-interaction.entity";
import { InteractionController } from "./presentation/controllers/interaction.controller";
import { InteractionIngestionService } from "./application/services/interaction-ingestion.service";
import { InteractionMessageProcessor } from "./application/services/interaction-message-processor.service";
import { InteractionProcessingService } from "./application/services/interaction-processing.service";
import { RecommendationInteractionRepository } from "./infrastructure/repositories/recommendation-interaction.repository";

@Module({
  imports: [KafkaModule, TypeOrmModule.forFeature([RecommendationInteractionEntity])],
  controllers: [InteractionController],
  providers: [
    InteractionIngestionService,
    InteractionMessageProcessor,
    InteractionProcessingService,
    RecommendationInteractionRepository,
    KafkaConsumerService,
  ],
})
export class InteractionsModule {}
