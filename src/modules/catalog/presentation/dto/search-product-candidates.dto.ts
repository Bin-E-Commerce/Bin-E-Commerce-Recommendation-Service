// DTO này giới hạn vector/candidate trước khi gọi Qdrant từ Product Service nội bộ.
import {
    ArrayMaxSize,
    ArrayNotEmpty,
    IsArray,
    IsBoolean,
    IsInt,
    IsNumber,
    IsOptional,
    Max,
    Min,
} from 'class-validator';

export class SearchProductCandidatesDto {
    @IsArray()
    @ArrayNotEmpty()
    @ArrayMaxSize(4096)
    @IsNumber({ allowNaN: false, allowInfinity: false }, { each: true })
    vector: number[];

    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(60)
    limit = 40;

    @IsOptional()
    @IsBoolean()
    inStockOnly = false;
}
