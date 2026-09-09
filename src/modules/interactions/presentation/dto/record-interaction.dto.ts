// DTO này là input public của ingestion route; identity được lấy từ trusted headers do API Gateway forward.

import { Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { RecommendationInteractionTypes } from "../../../../../../../packages/common/kafka/events/recommendation.events";

export class RecordInteractionDto {
  @IsIn(Object.values(RecommendationInteractionTypes))
  interactionType!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  productId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  variantId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  categoryId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  query?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  page?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1000)
  position?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  quantity?: number;

  @IsOptional()
  @IsISO8601()
  occurredAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  recommendationRequestId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  recommendationItemId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  recommendationSource?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  recommendationRank?: number;

  @IsOptional()
  @IsString()
  @IsIn(["home", "product_detail", "recommendations_page"])
  @MaxLength(32)
  surface?: "home" | "product_detail" | "recommendations_page";

  @IsOptional()
  @IsString()
  @MaxLength(64)
  recommendationPolicyVersion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  recommendationExperimentId?: string;

  @IsOptional()
  @IsIn(["CONTROL", "HYBRID"])
  recommendationExperimentVariant?: "CONTROL" | "HYBRID";
}
