// Controller này trả trạng thái HTTP và PostgreSQL tối thiểu cho healthcheck.
// Controller không ghi interaction, gọi model hay sinh recommendation.

import {
  Controller,
  Get,
  Header,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { KafkaProducerService } from "../../kafka/producers/kafka-producer.service";
import { RecommendationRedisService } from "../../infrastructure/redis/redis.module";
import { VectorIndexService } from "../catalog/application/services/vector/vector-index.service";
import { MetricsService } from "./metrics.service";

// Cung cấp thông tin sống của service để Docker và Gateway phát hiện lỗi hạ tầng sớm.
@ApiTags("Health")
@Controller("health")
export class HealthController {
  constructor(
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
    private readonly producer: KafkaProducerService,
    private readonly redis: RecommendationRedisService,
    private readonly vector: VectorIndexService,
    private readonly metrics: MetricsService,
  ) {}

  // Liveness chỉ xác nhận process còn chạy, không gọi dependency để tránh restart dây chuyền khi hạ tầng chậm.
  @Get("live")
  @ApiOperation({
    summary: "Kiểm tra process còn hoạt động",
    description:
      "Dùng cho liveness probe của Docker hoặc nền tảng triển khai. Endpoint chỉ xác nhận HTTP process còn nhận request, không gọi PostgreSQL, Kafka, Redis hay Qdrant; vì vậy dependency chậm không làm process bị restart dây chuyền.",
  })
  @ApiResponse({
    status: 200,
    description: "Process đang hoạt động; trả status và tên service.",
  })
  live() {
    return { status: "ok", service: "recommendation-service" };
  }

  // Readiness kiểm tra database/Kafka bắt buộc; Redis và Qdrant là dependency fail-soft vì pipeline có fallback.
  @Get("ready")
  @ApiOperation({
    summary: "Kiểm tra service đã sẵn sàng nhận việc",
    description:
      "Dùng cho readiness probe trước khi Gateway gửi traffic. PostgreSQL và Kafka là dependency bắt buộc; Redis và Qdrant được báo trạng thái degraded nhưng không làm service fail readiness vì recommendation có cơ chế fallback. Không nhận query hay body.",
  })
  @ApiResponse({
    status: 200,
    description:
      "Service sẵn sàng; trả trạng thái của PostgreSQL, Kafka, Redis và Qdrant.",
  })
  @ApiResponse({
    status: 503,
    description:
      "Service chưa sẵn sàng vì PostgreSQL hoặc Kafka đang down; response kèm trạng thái từng dependency.",
  })
  async ready() {
    const postgresUp = this.dataSource.isInitialized;
    const kafkaUp = this.producer.isConnected();
    const redisUp = await this.redis.isAvailable();
    const qdrantUp = await this.vector.getHealth();
    const checks = {
      postgres: { status: postgresUp ? "up" : "down" },
      kafka: { status: kafkaUp ? "up" : "down" },
      redis: { status: redisUp ? "up" : "degraded" },
      qdrant: { status: qdrantUp ? "up" : "degraded" },
    };
    if (!postgresUp || !kafkaUp) {
      throw new ServiceUnavailableException({
        status: "not_ready",
        service: "recommendation-service",
        checks,
      });
    }
    return { status: "ready", service: "recommendation-service", checks };
  }

  // Xuất metrics dạng Prometheus text format với label hữu hạn, không expose thông tin actor hoặc sản phẩm.
  @Get("metrics")
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  @ApiOperation({
    summary: "Đọc metrics cho Prometheus",
    description:
      "Dùng để hệ thống giám sát scrape số liệu vận hành của Recommendation Service. Response là văn bản theo Prometheus exposition format; endpoint không trả dữ liệu nhận diện người dùng hoặc sản phẩm.",
  })
  @ApiResponse({
    status: 200,
    description: "Các metrics dạng text/plain theo định dạng Prometheus.",
  })
  metricsEndpoint(): string {
    return this.metrics.render();
  }

  // Trả trạng thái không gây side effect, đủ nhẹ để được gọi định kỳ bởi runtime.
  @Get()
  @ApiOperation({
    summary: "Đọc thông tin sức khỏe tổng quát",
    description:
      "Dùng để xem nhanh phiên bản, môi trường, thời gian hoạt động và trạng thái kết nối PostgreSQL hiện tại. Endpoint chỉ đọc trạng thái connection, không chạy truy vấn kiểm tra nặng và không thay thế readiness probe chi tiết.",
  })
  @ApiResponse({
    status: 200,
    description: "Thông tin service, uptime và trạng thái HTTP/PostgreSQL.",
  })
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
