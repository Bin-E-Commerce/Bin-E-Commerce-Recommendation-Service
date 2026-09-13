import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { timingSafeEqual } from "node:crypto";
import type { Request } from "express";

// Guard này chặn Admin endpoint ở service boundary; browser không được phép gọi trực tiếp Recommendation Service.
@Injectable()
export class RecommendationAdminInternalGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  // So sánh internal token an toàn và từ chối khi deployment chưa cấu hình secret.
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const expected = this.config.get<string>("INTERNAL_SERVICE_TOKEN", "");
    const received = request.header("x-internal-service-token") ?? "";
    if (!expected || !received) {
      throw new UnauthorizedException("Invalid internal service token");
    }

    const expectedBuffer = Buffer.from(expected, "utf8");
    const receivedBuffer = Buffer.from(received, "utf8");
    if (
      expectedBuffer.length !== receivedBuffer.length ||
      !timingSafeEqual(expectedBuffer, receivedBuffer)
    ) {
      throw new UnauthorizedException("Invalid internal service token");
    }
    return true;
  }
}
