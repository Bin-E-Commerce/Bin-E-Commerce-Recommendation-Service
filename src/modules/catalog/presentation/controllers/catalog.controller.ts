// Controller này chỉ mở endpoint bootstrap nội bộ; candidate serving không được phép gọi Product Service request-time.

import { Controller, Headers, Post } from "@nestjs/common";
import { CatalogService } from "../../application/services/catalog/catalog.service";

@Controller("recommendation/catalog")
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  // Chạy initial sync có token nội bộ để nạp catalog hiện hữu trước khi Kafka catalog events hoạt động.
  @Post("bootstrap")
  bootstrap(@Headers("x-internal-service-token") token?: string) {
    return this.catalogService.bootstrapFromProductService(token);
  }
}
