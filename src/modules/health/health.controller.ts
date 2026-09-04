// Controller này trả trạng thái HTTP và PostgreSQL tối thiểu cho healthcheck.
// Controller không ghi interaction, gọi model hay sinh recommendation.

import { Controller, Get } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";

// Cung cấp thông tin sống của service để Docker và Gateway phát hiện lỗi hạ tầng sớm.
@Controller("health")
export class HealthController {
  constructor(
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
  ) {}

  // Trả trạng thái không gây side effect, đủ nhẹ để được gọi định kỳ bởi runtime.
  @Get()
  check() {
    const postgres = this.postgresStatus();
    return {
      status: postgres.status === "up" ? "ok" : "degraded",
      service: "recommendation-service",
      version: this.config.get<string>("APP_VERSION", "1.0.0"),
      environment: this.config.get<string>("NODE_ENV", "development"),
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      checks: { http: { status: "ok" }, postgres },
    };
  }

  // Đọc trạng thái connection hiện tại thay vì chạy query nặng trong endpoint health.
  private postgresStatus() {
    return {
      status: this.dataSource.isInitialized ? "up" : "down",
      database: this.dataSource.options.database ?? null,
      type: this.dataSource.options.type,
    };
  }
}
