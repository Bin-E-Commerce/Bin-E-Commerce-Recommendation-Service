// Module analytics nội bộ, chỉ sở hữu read model popularity và không chứa business transaction.

import { Module } from "@nestjs/common";
import { InternalServiceTokenGuard } from "../../common/security/internal-service-token.guard";
import { ProductImpactController } from "./presentation/product-impact.controller";
import { ProductImpactService } from "./application/product-impact.service";
import { ProductImpactRepository } from "./infrastructure/product-impact.repository";

@Module({
  controllers: [ProductImpactController],
  providers: [
    InternalServiceTokenGuard,
    ProductImpactService,
    ProductImpactRepository,
  ],
})
export class AnalyticsModule {}
