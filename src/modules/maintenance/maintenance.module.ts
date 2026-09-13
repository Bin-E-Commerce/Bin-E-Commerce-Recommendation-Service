// Module chứa các worker maintenance của Recommendation Service, tách khỏi request path và các bounded context nghiệp vụ.

import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { RetentionService } from "./application/services/retention/retention.service";
import { RetentionRepository } from "./infrastructure/repositories/retention.repository";
import { RecommendationReplayJobEntity } from "../../database/maintenance/entities/replay-job.entity";
import { RecommendationReplayJobEventEntity } from "../../database/maintenance/entities/replay-job-event.entity";
import { ReplayService } from "./application/services/replay/replay.service";
import { ReplayRepository } from "./infrastructure/repositories/replay.repository";
import { ReplayController } from "./presentation/controllers/replay.controller";

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
