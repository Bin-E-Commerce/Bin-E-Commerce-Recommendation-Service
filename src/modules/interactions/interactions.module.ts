// Module này đóng gói interaction flow: HTTP ingestion, Kafka processing và PostgreSQL read model.

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { KafkaModule } from '@/kafka/kafka.module';
import { KafkaConsumerService } from '@/kafka/consumers/interactions/kafka-consumer.service';
import { RecommendationInteractionEntity } from '@/database/interactions/entities/interaction.entity';
import { InteractionController } from '@/modules/interactions/presentation/controllers/interaction.controller';
import { InteractionIngestionService } from '@/modules/interactions/application/services/ingestion/interaction-ingestion.service';
import { InteractionMessageProcessor } from '@/kafka/consumers/processors/interaction-message.processor';
import { InteractionProcessingService } from '@/modules/interactions/application/services/processing/interaction-processing.service';
import { RecommendationInteractionRepository } from '@/modules/interactions/infrastructure/repositories/recommendation-interaction.repository';
import { ProfilesModule } from '@/modules/profiles/profiles.module';
import { CatalogModule } from '@/modules/catalog/catalog.module';
import { RecommendationModule } from '@/modules/recommendation/recommendation.module';

@Module({
    imports: [
        KafkaModule,
        ProfilesModule,
        CatalogModule,
        RecommendationModule,
        TypeOrmModule.forFeature([RecommendationInteractionEntity]),
    ],
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
