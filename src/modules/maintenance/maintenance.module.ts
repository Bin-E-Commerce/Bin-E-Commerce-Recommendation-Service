// Module chứa các worker maintenance của Recommendation Service, tách khỏi request path và các bounded context nghiệp vụ.

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RetentionService } from '@/modules/maintenance/application/services/retention/retention.service';
import { RetentionRepository } from '@/modules/maintenance/infrastructure/repositories/retention.repository';
import { RecommendationReplayJobEntity } from '@/database/maintenance/entities/replay-job.entity';
import { RecommendationReplayJobEventEntity } from '@/database/maintenance/entities/replay-job-event.entity';
import { ReplayService } from '@/modules/maintenance/application/services/replay/replay.service';
import { ReplayRepository } from '@/modules/maintenance/infrastructure/repositories/replay.repository';
import { ReplayController } from '@/modules/maintenance/presentation/controllers/replay.controller';

// Đăng ký retention worker nhưng mặc định không tự xóa nếu chưa bật environment flag.
@Module({
    imports: [
        TypeOrmModule.forFeature([
            RecommendationReplayJobEntity,
            RecommendationReplayJobEventEntity,
        ]),
    ],
    controllers: [ReplayController],
    providers: [
        RetentionService,
        RetentionRepository,
        ReplayService,
        ReplayRepository,
    ],
})
export class MaintenanceModule {}
