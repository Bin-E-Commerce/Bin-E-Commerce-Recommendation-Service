// DTO policy nhận object weight linh hoạt để thêm feature trong tương lai nhưng application service vẫn whitelist key.

import {
  IsBoolean,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";

export class UpdateRecommendationPolicyDto {
  @IsOptional()
  @IsObject()
  hybridWeights?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  mlEnabled?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(0.5)
  mlBlend?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
