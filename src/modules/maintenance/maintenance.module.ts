// Module chứa các worker maintenance của Recommendation Service, tách khỏi request path và các bounded context nghiệp vụ.

import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { RetentionService } from "./retention.service";
import { RecommendationReplayJobEntity } from "../../database/maintenance/entities/replay-job.entity";
import { RecommendationReplayJobEventEntity } from "../../database/maintenance/entities/replay-job-event.entity";
import { ReplayService } from "./application/replay.service";
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
  providers: [RetentionService, ReplayService],
})
export class MaintenanceModule {}
