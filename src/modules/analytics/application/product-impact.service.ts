// Application service điều phối product impact analytics.
// Service chỉ validate batch, gọi repository và ghép response; phép tính timestamp/daily nằm ở calculator riêng.

import { BadRequestException, Injectable } from "@nestjs/common";
import { ProductImpactRepository } from "../infrastructure/product-impact.repository";
import { ProductImpactRequestDto } from "../presentation/dto/product-impact.dto";
import type { ProductImpactResponse } from "./types/product-impact.types";
import { buildProductImpactItem } from "./utils/product-impact-calculator";

// Điều phối query và calculation nhưng không sở hữu chi tiết gom ngày hoặc tính metric.
@Injectable()
export class ProductImpactService {
  constructor(private readonly repository: ProductImpactRepository) {}

  // Chặn product trùng, xác thực range trước khi query rồi map từng product bằng calculator thuần.
  async compare(
    request: ProductImpactRequestDto,
  ): Promise<ProductImpactResponse> {
    const productIds = request.comparisons.map(
      (comparison) => comparison.productId,
    );
    if (new Set(productIds).size !== productIds.length) {
      throw new BadRequestException("Duplicate productId is not allowed");
    }

    request.comparisons.forEach((comparison) =>
      ProductImpactRepository.assertValidRange(comparison),
    );
    const rows = await this.repository.compare(request.comparisons);

    return {
      items: request.comparisons.map((comparison) =>
        buildProductImpactItem(rows, comparison),
      ),
    };
  }
}
