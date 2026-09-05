// Controller này nhận interaction từ API Gateway và chỉ điều phối sang application service, không chứa ranking logic.

import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import { InteractionIngestionService } from "../../application/services/interaction-ingestion.service";
import { RecordInteractionDto } from "../dto/record-interaction.dto";

@Controller("recommendation")
export class InteractionController {
  // Inject application boundary để controller không biết Kafka topic hay persistence details.
  constructor(private readonly ingestionService: InteractionIngestionService) {}

  // Trả 202 ngay sau khi Kafka nhận event; xử lý database diễn ra bất đồng bộ bởi consumer.
  @Post("events")
  @HttpCode(HttpStatus.ACCEPTED)
  async recordInteraction(
    @Body() dto: RecordInteractionDto,
    @Req() request: Request,
  ): Promise<{ accepted: true; eventId: string; status: "queued" }> {
    const result = await this.ingestionService.record(dto, request);
    return { accepted: true, eventId: result.eventId, status: "queued" };
  }
}
