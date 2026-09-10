// Module này công bố endpoint health của Recommendation Service cho Gateway và container runtime.
// Module chỉ phản ánh trạng thái hạ tầng, không kiểm tra chất lượng hoặc độ chính xác recommendation.

import { Global, Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { KafkaModule } from "../../kafka/kafka.module";
import { RecommendationRedisModule } from "../../infrastructure/redis/redis.module";
import { CatalogModule } from "../catalog/catalog.module";
import { MetricsService } from "./metrics.service";

// Đăng ký health controller độc lập để kiểm tra service không phụ thuộc module nghiệp vụ.
@Global()
@Module({
  imports: [KafkaModule, RecommendationRedisModule, CatalogModule],
  controllers: [HealthController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class HealthModule {}
