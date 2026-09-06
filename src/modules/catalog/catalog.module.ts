// Module này quản lý catalog read model và bootstrap dữ liệu hiện hữu; không sở hữu Product master hoặc checkout rules.

import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { RecommendationCatalogProductEntity } from "../../database/catalog/entities/catalog-product.entity";
import { CatalogService } from "./application/services/catalog.service";
import { CatalogController } from "./presentation/controllers/catalog.controller";
import { CatalogProductRepository } from "./infrastructure/repositories/catalog-product.repository";

@Module({
  imports: [TypeOrmModule.forFeature([RecommendationCatalogProductEntity])],
  controllers: [CatalogController],
  providers: [CatalogProductRepository, CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
