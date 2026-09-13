// Controller này nhận interaction từ API Gateway và chỉ điều phối sang application service, không chứa ranking logic.

import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { InteractionIngestionService } from "../../application/services/ingestion/interaction-ingestion.service";
import { RecordInteractionBatchDto } from "../dto/record-interaction-batch.dto";
import { RecordInteractionDto } from "../dto/record-interaction.dto";

@ApiTags("Recommendation - Interactions")
@Controller("recommendation")
export class InteractionController {
  // Inject application boundary để controller không biết Kafka topic hay persistence details.
  constructor(private readonly ingestionService: InteractionIngestionService) {}

  // Trả 202 ngay sau khi Kafka nhận event; xử lý database diễn ra bất đồng bộ bởi consumer.
  @Post("events")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: "Ghi nhận một sự kiện tương tác",
    description: [
      "Mục đích: tiếp nhận một hành động của người dùng/khách như xem, click, thêm giỏ hoặc mua để cập nhật tín hiệu cho recommendation và analytics.",
      "Đầu vào: body theo RecordInteractionDto; định danh user hoặc guest session được lấy từ trusted headers do API Gateway chuyển tiếp, không lấy userId từ body. Có thể kèm thông tin attribution như request/item ID, vị trí và ranking variant.",
      "Xử lý và kết quả: service chuẩn hóa event, cấp eventId rồi publish vào Kafka. HTTP 202 chỉ có nghĩa event đã được queue tiếp nhận; consumer sẽ xử lý và lưu dữ liệu bất đồng bộ, không phải dữ liệu analytics đã cập nhật xong.",
      "Lưu ý: body hoặc identity không hợp lệ bị từ chối; nếu Kafka không nhận event thì trả lỗi để caller có thể retry.",
    ].join("\n\n"),
  })
  @ApiResponse({
    status: 202,
    description:
      "Event đã được đưa vào hàng đợi; trả eventId và trạng thái queued.",
  })
  @ApiResponse({
    status: 400,
    description: "Body không hợp lệ hoặc thiếu user/guest session hợp lệ.",
  })
  @ApiResponse({
    status: 503,
    description:
      "Kafka tạm thời không khả dụng nên event chưa được xác nhận tiếp nhận.",
  })
  async recordInteraction(
    @Body() dto: RecordInteractionDto,
    @Req() request: Request,
  ): Promise<{ accepted: true; eventId: string; status: "queued" }> {
    const result = await this.ingestionService.record(dto, request);
    return { accepted: true, eventId: result.eventId, status: "queued" };
  }

  // Nhận nhiều impression trong một request; service chỉ trả 202 sau khi toàn bộ batch đã được đưa vào Kafka.
  @Post("events/batch")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: "Ghi nhận một nhóm sự kiện tương tác",
    description: [
      "Mục đích: gửi nhiều event trong một request, thường dùng khi trang ghi nhận nhiều lượt sản phẩm được hiển thị, để giảm số lần gọi mạng.",
      "Đầu vào: body có mảng events gồm 1–50 phần tử; từng phần tử dùng cùng cấu trúc và validation với API ghi nhận một event. Tất cả event trong request gắn với cùng user/guest identity lấy từ trusted headers.",
      "Xử lý và kết quả: service tạo và kiểm tra toàn bộ event trước khi publish batch lên Kafka; thành công trả HTTP 202 cùng eventIds tương ứng. Consumer vẫn lưu và xử lý bất đồng bộ.",
      "Lưu ý: batch rỗng/quá 50 phần tử, event sai hoặc identity không hợp lệ bị từ chối; Kafka lỗi khiến request trả lỗi thay vì báo queued thành công.",
    ].join("\n\n"),
  })
  @ApiResponse({
    status: 202,
    description:
      "Toàn bộ batch đã được đưa vào hàng đợi; trả danh sách eventIds và trạng thái queued.",
  })
  @ApiResponse({
    status: 400,
    description:
      "Batch phải có 1–50 event hợp lệ và request cần user/guest session hợp lệ.",
  })
  @ApiResponse({
    status: 503,
    description:
      "Kafka tạm thời không khả dụng nên batch chưa được xác nhận tiếp nhận.",
  })
  async recordInteractionBatch(
    @Body() dto: RecordInteractionBatchDto,
    @Req() request: Request,
  ): Promise<{ accepted: true; eventIds: string[]; status: "queued" }> {
    const result = await this.ingestionService.recordMany(dto.events, request);
    return { accepted: true, eventIds: result.eventIds, status: "queued" };
  }
}
