// DTO internal cho phép AI Service gửi nhiều cửa sổ so sánh trong một request bounded.

import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from "class-validator";

export class ProductImpactComparisonDto {
  // Key do AI Service tạo để ghép response về đúng job, không mang ý nghĩa business riêng.
  @IsString()
  @MaxLength(180)
  key!: string;

  // Product ID đã được AI Service lấy từ job thuộc seller hiện tại.
  @IsUUID()
  productId!: string;

  // Các mốc ngày do AI Service giới hạn theo baseline và cửa sổ theo dõi daily.
  @IsOptional()
  @IsISO8601({ strict: true })
  beforeFrom!: string | null;

  @IsISO8601({ strict: true })
  beforeTo!: string;

  @IsISO8601({ strict: true })
  afterFrom!: string;

  @IsISO8601({ strict: true })
  afterTo!: string;
}

export class ProductImpactRequestDto {
  // Giới hạn batch để câu SQL aggregate không tạo request quá lớn trong service mesh.
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ProductImpactComparisonDto)
  comparisons!: ProductImpactComparisonDto[];
}
