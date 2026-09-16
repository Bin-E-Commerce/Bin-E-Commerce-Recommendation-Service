// DTO policy nhận object weight linh hoạt để thêm feature trong tương lai nhưng application service vẫn whitelist key.

import { Type } from "class-transformer";
import {
  IsBoolean,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

export class CandidateSourcesPolicyDto {
  @IsOptional()
  @IsBoolean()
  semanticEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  coBehaviorEnabled?: boolean;
}

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
  @IsBoolean()
  experimentEnabled?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  trafficPercent?: number;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => CandidateSourcesPolicyDto)
  candidateSources?: CandidateSourcesPolicyDto;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
