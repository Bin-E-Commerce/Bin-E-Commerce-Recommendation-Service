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
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import { ReplayService } from "../../application/services/replay/replay.service";
import { CreateReplayJobDto } from "../dto/create-replay-job.dto";

// Expose create/status API cho CLI hoặc operator tool đã nằm trong private network.
@ApiTags("Internal - Event Replay")
@Controller("internal/replay")
export class ReplayController {
  constructor(private readonly replay: ReplayService) {}

  // Tạo bounded replay job tối đa 100 event và trả ngay metadata để worker xử lý bất đồng bộ.
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: "Tạo job phát lại các event đã chọn",
    description: [
      "Mục đích: cho operator/CLI phát lại event vào đúng Kafka pipeline khi cần khôi phục hoặc xử lý lại dữ liệu; endpoint không chạy luồng publish đồng bộ trong thời gian dài.",
      "Đầu vào: header x-internal-service-token; body gồm sourceTopic trong danh sách topic được cho phép và events tối đa 100 phần tử. Mỗi event phải có eventId ổn định và eventName; hệ thống cũng hỗ trợ envelope có originalEvent.",
      "Xử lý và kết quả: kiểm tra topic, eventId trùng và payload, lưu job cùng payload bền vững rồi trả HTTP 202. Worker nền publish lại, retry khi lỗi và cập nhật trạng thái job; response ban đầu không có nghĩa toàn bộ event đã publish xong.",
      "Lưu ý: token sai, topic không được phép hoặc event không hợp lệ bị từ chối. Không dùng endpoint này để gửi event mới từ luồng người dùng thông thường.",
    ].join("\n\n"),
  })
  @ApiResponse({
    status: 202,
    description:
      "Replay job đã được tạo; trả metadata để theo dõi tiến độ bằng jobId.",
  })
  @ApiResponse({
    status: 400,
    description:
      "Body sai cấu trúc, vượt giới hạn 100 event hoặc thiếu trường bắt buộc.",
  })
  @ApiResponse({
    status: 401,
    description:
      "Internal token sai, topic không được phép hoặc event thiếu/đụng eventId.",
  })
  create(
    @Body() input: CreateReplayJobDto,
    @Headers("x-internal-service-token") token?: string,
  ) {
    return this.replay.create(input, token);
  }

  // Đọc tiến độ replay bằng job ID, không cho phép xem payload event.
  @Get(":jobId")
  @ApiOperation({
    summary: "Xem trạng thái một replay job",
    description: [
      "Mục đích: cho operator biết job đang chờ, đang chạy, hoàn tất hay thất bại và theo dõi số event đã publish/lỗi.",
      "Đầu vào: jobId UUID trên đường dẫn và x-internal-service-token hợp lệ.",
      "Kết quả: metadata job như topic, trạng thái, tổng số, số đã publish/thất bại, lỗi gần nhất và các mốc thời gian. API không trả payload của event để tránh lộ dữ liệu replay.",
      "Lưu ý: job không tồn tại trả 404; đây là API nội bộ, không dành cho browser hoặc người dùng cuối.",
    ].join("\n\n"),
  })
  @ApiParam({
    name: "jobId",
    description: "UUID của replay job nhận từ API tạo job.",
  })
  @ApiResponse({
    status: 200,
    description: "Thông tin trạng thái job, không bao gồm payload event.",
  })
  @ApiResponse({
    status: 401,
    description: "Thiếu hoặc sai internal service token.",
  })
  @ApiResponse({
    status: 404,
    description: "Không tìm thấy replay job có jobId này.",
  })
  get(
    @Param("jobId", new ParseUUIDPipe()) jobId: string,
    @Headers("x-internal-service-token") token?: string,
  ) {
    return this.replay.get(jobId, token);
  }
}
