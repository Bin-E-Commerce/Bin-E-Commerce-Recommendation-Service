// Module này gom Admin analytics và policy control theo bounded context; không sở hữu Product/Order data.

import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { RecommendationInteractionEntity } from "../../database/interactions/entities/interaction.entity";
import { RecommendationPolicyEntity } from "../../database/policies/entities/policy.entity";
import { CatalogModule } from "../catalog/catalog.module";
import { ProfilesModule } from "../profiles/profiles.module";
import { AdminRecommendationController } from "./presentation/controllers/admin-recommendation.controller";
import { AdminRecommendationService } from "./application/services/admin-recommendation.service";
import { AdminRecommendationBootstrapService } from "./application/services/admin-recommendation-bootstrap.service";
import { RecommendationAdminRepository } from "./infrastructure/repositories/recommendation-admin.repository";
import { RecommendationAdminInternalGuard } from "./presentation/guards/recommendation-admin-internal.guard";
import { RecommendationAccountDirectoryClient } from "./infrastructure/clients/recommendation-account-directory.client";

@Module({
  imports: [
    CatalogModule,
    ProfilesModule,
    TypeOrmModule.forFeature([
      RecommendationInteractionEntity,
      RecommendationPolicyEntity,
    ]),
  ],
  controllers: [AdminRecommendationController],
  providers: [
    RecommendationAdminRepository,
    AdminRecommendationService,
    AdminRecommendationBootstrapService,
    RecommendationAdminInternalGuard,
    RecommendationAccountDirectoryClient,
  ],
})
export class AdminRecommendationModule {}
