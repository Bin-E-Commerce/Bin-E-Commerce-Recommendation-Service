// DTO này xác thực session guest ở HTTP boundary; userId luôn lấy từ trusted header của Gateway.

import { IsUUID } from "class-validator";

export class MergeRecommendationSessionDto {
  // Session UUID là định danh duy nhất để merge idempotent và không nhận chuỗi tùy ý từ client.
  @IsUUID()
  sessionId!: string;
}
