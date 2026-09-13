// DTO này giới hạn batch tracking ở boundary HTTP; mỗi phần tử vẫn dùng cùng contract và validation như event đơn.

import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  ValidateNested,
} from "class-validator";
import { RecordInteractionDto } from "./record-interaction.dto";

// Nhận tối đa 50 event một lần để giảm round-trip nhưng vẫn giới hạn payload và thời gian xử lý của request.
export class RecordInteractionBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => RecordInteractionDto)
  events!: RecordInteractionDto[];
}
