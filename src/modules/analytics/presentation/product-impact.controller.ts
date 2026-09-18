// HTTP boundary internal cho AI Service đọc aggregate view/sales theo product.

import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { InternalServiceTokenGuard } from "../../../common/security/internal-service-token.guard";
import { ProductImpactService } from "../application/product-impact.service";
import { ProductImpactRequestDto } from "./dto/product-impact.dto";

// Endpoint không được expose qua API Gateway; guard chỉ chấp nhận service token.
@Controller("internal/analytics")
@UseGuards(InternalServiceTokenGuard)
export class ProductImpactController {
  constructor(private readonly service: ProductImpactService) {}

  // Aggregate một batch tối đa 100 comparison để AI Service không phải gửi N request.
  @Post("product-impact")
  compare(@Body() request: ProductImpactRequestDto) {
    return this.service.compare(request);
  }
}
