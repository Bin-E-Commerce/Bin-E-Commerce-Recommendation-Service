// Module này đóng gói interaction flow: HTTP ingestion, Kafka processing và PostgreSQL read model.

import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { KafkaModule } from "../../kafka/kafka.module";
import { KafkaConsumerService } from "../../kafka/consumers/kafka-consumer.service";
import { RecommendationInteractionEntity } from "../../database/interactions/entities/interaction.entity";
import { InteractionController } from "./presentation/controllers/interaction.controller";
import { InteractionIngestionService } from "./application/services/ingestion/interaction-ingestion.service";
import { InteractionMessageProcessor } from "../../kafka/consumers/processors/interaction-message.processor";
import { InteractionProcessingService } from "./application/services/processing/interaction-processing.service";
import { RecommendationInteractionRepository } from "./infrastructure/repositories/recommendation-interaction.repository";
import { ProfilesModule } from "../profiles/profiles.module";
import { CatalogModule } from "../catalog/catalog.module";

@Module({
  imports: [KafkaModule, ProfilesModule, CatalogModule, TypeOrmModule.forFeature([RecommendationInteractionEntity])],
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
