// File này khởi động Recommendation Service, cấu hình HTTP chung và công bố API version v1.
// File không chứa logic chọn sản phẩm; các luật recommendation sẽ thuộc từng bounded context riêng.

import { NestFactory } from "@nestjs/core";
import { ValidationPipe, VersioningType } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import helmet from "helmet";
import { AppModule } from "./app.module";

// Khởi động service với validation và security middleware thống nhất trước khi nhận request.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: ["error", "warn", "log"],
  });

  const config = app.get(ConfigService);
  const isDev = config.get<string>("NODE_ENV") !== "production";
  const port = config.get<number>("PORT", 3006);

  app.use(helmet());
  app.setGlobalPrefix("api");
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.enableCors({ origin: false });

  if (isDev) {
    const documentConfig = new DocumentBuilder()
      .setTitle("Recommendation Service")
      .setDescription("Adaptive product recommendation and interaction APIs")
      .setVersion("1.0")
      .build();
    SwaggerModule.setup(
      "docs",
      app,
      SwaggerModule.createDocument(app, documentConfig),
    );
  }

  app.enableShutdownHooks();
  await app.listen(port);
  console.log(`[recommendation-service] Running on port ${port}`);
}

void bootstrap();
