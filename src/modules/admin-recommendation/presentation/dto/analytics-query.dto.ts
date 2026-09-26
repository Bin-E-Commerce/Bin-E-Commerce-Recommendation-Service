// DTO này giới hạn cửa sổ thời gian và page để Admin không tạo truy vấn aggregate vô hạn.

import { Type } from 'class-transformer';
import {
    IsDate,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    Max,
    MaxLength,
    Min,
} from 'class-validator';

export class AnalyticsQueryDto {
    @IsOptional()
    @Type(() => Date)
    @IsDate()
    from?: Date;

    @IsOptional()
    @Type(() => Date)
    @IsDate()
    to?: Date;
}

export class ActorQueryDto extends AnalyticsQueryDto {
    @IsOptional()
    @IsIn(['USER', 'SESSION'])
    actorType?: 'USER' | 'SESSION';

    @IsOptional()
    @IsString()
    @MaxLength(128)
    search?: string;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(1000)
    page = 1;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(100)
    pageSize = 20;
}

export class ActivityQueryDto extends AnalyticsQueryDto {
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(1000)
    page = 1;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(50)
    pageSize = 10;
}
