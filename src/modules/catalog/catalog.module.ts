// Module này quản lý catalog read model và bootstrap dữ liệu hiện hữu; không sở hữu Product master hoặc checkout rules.

import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { RecommendationCatalogProductEntity } from "../../database/catalog/entities/catalog-product.entity";
import { CatalogService } from "./application/services/catalog/catalog.service";
import { CatalogController } from "./presentation/controllers/catalog.controller";
import { CatalogProductRepository } from "./infrastructure/repositories/catalog-product.repository";
import { RecommendationEmbeddingJobEntity } from "../../database/embedding/entities/embedding-job.entity";
import { RecommendationCatalogSyncCheckpointEntity } from "../../database/catalog/entities/catalog-sync-checkpoint.entity";
import { EmbeddingJobRepository } from "./infrastructure/repositories/embedding-job.repository";
import { EmbeddingJobService } from "./application/services/embedding/embedding-job.service";
import { SemanticContentService } from "./application/services/semantic/semantic-content.service";
import { VectorIndexService } from "./application/services/vector/vector-index.service";
import { EmbeddingConsumerService } from "../../kafka/consumers/embedding-consumer.service";
import { CatalogSyncCheckpointRepository } from "./infrastructure/repositories/catalog-sync-checkpoint.repository";

@Module({
  imports: [TypeOrmModule.forFeature([RecommendationCatalogProductEntity, RecommendationEmbeddingJobEntity, RecommendationCatalogSyncCheckpointEntity])],
  controllers: [CatalogController],
  providers: [CatalogProductRepository, CatalogSyncCheckpointRepository, EmbeddingJobRepository, EmbeddingJobService, SemanticContentService, VectorIndexService, EmbeddingConsumerService, CatalogService],
  exports: [CatalogService, CatalogProductRepository, EmbeddingJobRepository, SemanticContentService, VectorIndexService],
})
export class CatalogModule {}
