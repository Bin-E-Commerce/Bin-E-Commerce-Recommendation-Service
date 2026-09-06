// DTO này giới hạn surface và pagination để recommendation request không biến thành truy vấn catalog tùy ý.

import { Transform } from "class-transformer";
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from "class-validator";
import type { RecommendationSurface } from "../../application/types/recommendation.types";

export class RecommendationQueryDto {
  @IsEnum(["home", "product_detail", "recommendations_page"])
  surface!: RecommendationSurface;

  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(24)
  pageSize = 24;
}
