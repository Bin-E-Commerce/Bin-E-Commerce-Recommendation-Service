// Controller này chỉ mở endpoint bootstrap nội bộ; candidate serving không được phép gọi Product Service request-time.

import { Controller, Headers, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CatalogService } from '@/modules/catalog/application/services/catalog/catalog.service';

@ApiTags('Recommendation - Internal Catalog')
@Controller('recommendation/catalog')
export class CatalogController {
    constructor(private readonly catalogService: CatalogService) {}

    // Chạy initial sync có token nội bộ để nạp catalog hiện hữu trước khi Kafka catalog events hoạt động.
    @Post('bootstrap')
    @ApiOperation({
        summary: 'Đồng bộ catalog ban đầu từ Product Service',
        description: [
            'Mục đích: nạp snapshot sản phẩm hiện có vào catalog nội bộ khi khởi tạo môi trường hoặc cần chạy lại đồng bộ; đây không phải API lấy sản phẩm trong mỗi request gợi ý.',
            'Đầu vào: không có body; cần x-internal-service-token hợp lệ. Service tự đọc Product Service theo từng trang và lưu checkpoint để có thể tiếp tục đồng bộ.',
            'Kết quả: trả số sản phẩm đã import và số trang đã đọc. Candidate serving dùng catalog nội bộ sau đó, không gọi Product Service theo từng lượt gợi ý.',
            'Lưu ý: token sai bị từ chối; lỗi khi gọi Product Service hoặc lưu snapshot làm request thất bại để operator có thể kiểm tra và chạy lại.',
        ].join('\n\n'),
    })
    @ApiResponse({
        status: 201,
        description: 'Đồng bộ hoàn tất; trả imported và pages.',
    })
    @ApiResponse({
        status: 401,
        description: 'Thiếu hoặc sai internal service token.',
    })
    @ApiResponse({
        status: 500,
        description:
            'Không đồng bộ được snapshot từ Product Service hoặc lưu catalog.',
    })
    bootstrap(@Headers('x-internal-service-token') token?: string) {
        return this.catalogService.bootstrapFromProductService(token);
    }
}
