// Service tạo attribution token ngắn, có chữ ký server để Interaction Ingestion xác thực metadata recommendation.
// Token không chứa PII; secret chỉ dùng để chống client tự thay đổi request/product/rank/experiment.

import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac, timingSafeEqual } from "node:crypto";

export interface RecommendationTrackingTokenInput {
  actorId: string;
  requestId: string;
  productId: string;
  rank: number;
  source: string;
  surface: "home" | "product_detail" | "recommendations_page";
  policyVersion: string;
  experimentId: string | null;
  experimentVariant: "CONTROL" | "HYBRID" | null;
}

@Injectable()
export class RecommendationTrackingTokenService {
  private readonly secret: string;

  constructor(config: ConfigService) {
    const configuredSecret = config
      .get<string>("RECOMMENDATION_TRACKING_SECRET")
      ?.trim();
    if (!configuredSecret && config.get<string>("NODE_ENV") === "production") {
      throw new Error(
        "RECOMMENDATION_TRACKING_SECRET is required in production",
      );
    }
    // Fallback chỉ dành cho local; production không được dùng secret mặc định có thể đoán được.
    this.secret = configuredSecret ?? "local-recommendation-tracking-secret";
  }

  // Tạo token cố định theo attribution context để cùng một response cache vẫn theo dõi được cùng một item.
  create(input: RecommendationTrackingTokenInput): string {
    return createHmac("sha256", this.secret)
      .update(this.serialize(input))
      .digest("base64url");
  }

  // Xác thực token bằng so sánh constant-time trước khi event được đưa vào Kafka.
  verify(token: string, input: RecommendationTrackingTokenInput): boolean {
    const expected = Buffer.from(this.create(input));
    const received = Buffer.from(token);
    return (
      expected.length === received.length && timingSafeEqual(expected, received)
    );
  }

  // Serialize theo thứ tự cố định để chữ ký không phụ thuộc thứ tự key của object.
  private serialize(input: RecommendationTrackingTokenInput): string {
    return JSON.stringify([
      input.actorId,
      input.requestId,
      input.productId,
      input.rank,
      input.source,
      input.surface,
      input.policyVersion,
      input.experimentId,
      input.experimentVariant,
    ]);
  }
}
