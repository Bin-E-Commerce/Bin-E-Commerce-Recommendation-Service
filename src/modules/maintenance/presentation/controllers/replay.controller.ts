// Internal HTTP boundary cho replay; chỉ đọc token từ trusted internal header và không nhận user identity từ body.

import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from "@nestjs/common";
import { ReplayService } from "../../application/replay.service";
import { CreateReplayJobDto } from "../dto/create-replay-job.dto";

// Expose create/status API cho CLI hoặc operator tool đã nằm trong private network.
@Controller("internal/replay")
export class ReplayController {
  constructor(private readonly replay: ReplayService) {}

  // Tạo bounded replay job tối đa 100 event và trả ngay metadata để worker xử lý bất đồng bộ.
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  create(
    @Body() input: CreateReplayJobDto,
    @Headers("x-internal-service-token") token?: string,
  ) {
    return this.replay.create(input, token);
  }

  // Đọc tiến độ replay bằng job ID, không cho phép xem payload event.
  @Get(":jobId")
  get(
    @Param("jobId", new ParseUUIDPipe()) jobId: string,
    @Headers("x-internal-service-token") token?: string,
  ) {
    return this.replay.get(jobId, token);
  }
}
