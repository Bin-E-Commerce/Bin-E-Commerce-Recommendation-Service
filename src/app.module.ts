// File này lắp các module hạ tầng và bounded context của Recommendation Service.
// File không truy vấn database của Product, Order hay Seller Service trực tiếp.

import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { KafkaModule } from "./kafka/kafka.module";
import { HealthModule } from "./modules/health/health.module";
import { InteractionsModule } from "./modules/interactions/interactions.module";
import { RecommendationRedisModule } from "./infrastructure/redis/redis.module";
import { RecommendationModule } from "./modules/recommendation/recommendation.module";
import { CatalogModule } from "./modules/catalog/catalog.module";

// Khai báo dependency graph của service và kết nối các bounded context vào runtime.
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [".env.local", ".env"],
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: "postgres" as const,
        host: config.get<string>("POSTGRES_HOST", "localhost"),
        port: config.get<number>("POSTGRES_PORT", 5432),
        username: config.get<string>("POSTGRES_USER"),
        password: config.get<string>("POSTGRES_PASSWORD"),
        database: config.get<string>("POSTGRES_DB"),
        entities: [__dirname + "/**/*.entity{.ts,.js}"],
        migrations: [__dirname + "/database/migrations/*{.ts,.js}"],
        // Migration là nguồn thay đổi schema duy nhất cho toàn bộ read model của service.
        migrationsRun: true,
        synchronize: false,
        ssl:
          config.get<string>("NODE_ENV") === "production"
            ? { rejectUnauthorized: false }
            : false,
        logging: config.get<string>("TYPEORM_LOGGING", "false") === "true",
      }),
    }),
    KafkaModule,
    RecommendationRedisModule,
    InteractionsModule,
    CatalogModule,
    RecommendationModule,
    HealthModule,
  ],
})
export class AppModule {}
