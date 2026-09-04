// Module này công bố endpoint health của Recommendation Service cho Gateway và container runtime.
// Module chỉ phản ánh trạng thái hạ tầng, không kiểm tra chất lượng hoặc độ chính xác recommendation.

import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";

// Đăng ký health controller độc lập để kiểm tra service không phụ thuộc module nghiệp vụ.
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
