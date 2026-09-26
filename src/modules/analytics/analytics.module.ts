// Module analytics nội bộ, chỉ sở hữu read model popularity và không chứa business transaction.

import { Module } from '@nestjs/common';
import { InternalServiceTokenGuard } from '@/common/security/internal-service-token.guard';
import { ProductImpactController } from '@/modules/analytics/presentation/product-impact.controller';
import { ProductImpactService } from '@/modules/analytics/application/product-impact.service';
import { ProductImpactRepository } from '@/modules/analytics/infrastructure/product-impact.repository';

@Module({
    controllers: [ProductImpactController],
    providers: [
        InternalServiceTokenGuard,
        ProductImpactService,
        ProductImpactRepository,
    ],
})
export class AnalyticsModule {}
