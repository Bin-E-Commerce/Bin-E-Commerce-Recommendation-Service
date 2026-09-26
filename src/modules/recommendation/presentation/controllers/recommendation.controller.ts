// Controller này là HTTP serving boundary cho Home, Product Detail và trang recommendation; không chứa ranking logic.

import {
    Controller,
    Get,
    Headers,
    Post,
    Body,
    UnauthorizedException,
    Query,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RecommendationQueryService } from '@/modules/recommendation/application/services/query/recommendation-query.service';
import { RecommendationQueryDto } from '@/modules/recommendation/presentation/dto/recommendation-query.dto';
import { MergeRecommendationSessionDto } from '@/modules/recommendation/presentation/dto/merge-recommendation-session.dto';
import { ProfileQueryService } from '@/modules/profiles/application/services/profile/profile-query.service';

const UUID_V4_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@ApiTags('Recommendation - Serving')
@Controller('recommendation')
export class RecommendationController {
    constructor(
        private readonly recommendationQuery: RecommendationQueryService,
        private readonly profile: ProfileQueryService,
    ) {}

    // Trả tối đa 24 item đã được backend candidate/ranking/pagination; guest chỉ được xem page đầu.
    @Get('recommendations')
    @ApiOperation({
        summary: 'Lấy danh sách sản phẩm được đề xuất',
        description: [
            'Mục đích: phục vụ danh sách gợi ý cho trang chủ, trang chi tiết sản phẩm hoặc trang recommendation; backend tự lấy candidate, xếp hạng và phân trang.',
            'Đầu vào: query surface nhận home, product_detail hoặc recommendations_page; productId là sản phẩm mốc tùy chọn; page mặc định 1, pageSize mặc định/tối đa 24. Với surface product_detail, backend trả tối đa 24 sản phẩm và loại sản phẩm hiện tại cùng shop của sản phẩm đó. Định danh lấy từ x-user-id hoặc x-session-id do Gateway chuyển tiếp.',
            'Kết quả: danh sách item có thông tin sản phẩm, thứ hạng, điểm/nguồn/lý do gợi ý cùng requestId, strategy, trạng thái hồ sơ, phân trang và metadata policy/model/ranking mode.',
            'Lưu ý: cần có user hoặc guest session UUID v4. Guest chỉ xem trang đầu; muốn lấy trang tiếp theo phải đăng nhập. Khi AI không thể chạy hợp lệ, hệ thống fallback về Standard Ranking và không ghi attribution nhầm thành AI.',
        ].join('\n\n'),
    })
    @ApiResponse({
        status: 200,
        description:
            'Danh sách sản phẩm đã xếp hạng cùng thông tin phân trang và metadata recommendation.',
    })
    @ApiResponse({
        status: 400,
        description:
            'Query không hợp lệ, ví dụ surface, UUID sản phẩm hoặc giới hạn phân trang sai.',
    })
    @ApiResponse({
        status: 401,
        description:
            'Thiếu identity hợp lệ, session sai định dạng hoặc guest yêu cầu trang sau trang đầu.',
    })
    async getRecommendations(
        @Query() query: RecommendationQueryDto,
        @Headers('x-user-id') userId?: string,
        @Headers('x-session-id') sessionId?: string,
    ) {
        const normalizedUserId = userId?.trim() || null;
        const normalizedSessionId = this.normalizeSessionId(sessionId);
        if (!normalizedUserId && !normalizedSessionId)
            throw new UnauthorizedException(
                'A user or guest session is required',
            );
        if (!normalizedUserId && query.page > 1)
            throw new UnauthorizedException({
                code: 'LOGIN_REQUIRED_FOR_MORE',
                message: 'Đăng nhập để xem thêm sản phẩm gợi ý.',
            });
        return this.recommendationQuery.getRecommendations(
            query,
            normalizedUserId,
            normalizedSessionId,
        );
    }

    // Chỉ nhận UUID v4 do Web/Gateway cấp để guest không thể tạo tùy ý Redis key hoặc đọc context của actor khác.
    private normalizeSessionId(sessionId?: string): string | null {
        const normalized = sessionId?.trim() || null;
        if (!normalized) return null;
        if (!UUID_V4_PATTERN.test(normalized)) {
            throw new UnauthorizedException(
                'A valid guest session is required',
            );
        }
        return normalized;
    }

    // Merge session được Gateway gọi sau login; userId chỉ lấy từ trusted header nên client không thể giả mạo actor đích.
    @Post('profile/merge')
    @ApiOperation({
        summary: 'Gộp hành vi guest vào hồ sơ sau khi đăng nhập',
        description: [
            'Mục đích: nối lịch sử/context của guest session với tài khoản vừa đăng nhập để các gợi ý sau đó tiếp tục dựa trên hành vi trước đăng nhập.',
            'Đầu vào: x-user-id là user đã xác thực do Gateway chuyển tiếp; body chứa sessionId UUID v4 của guest. Không chấp nhận userId đích do client tự khai trong body.',
            'Xử lý và kết quả: gộp context và preference qua repository; trả { merged: boolean }. Khi merge thành công, session context và cache của user được invalidated để request tiếp theo đọc dữ liệu mới.',
            'Lưu ý: session chỉ được dọn sau khi dữ liệu merge đã lưu thành công, nhờ đó lỗi giữa chừng không làm mất hành vi guest và request có thể retry an toàn.',
        ].join('\n\n'),
    })
    @ApiResponse({
        status: 201,
        description:
            'Yêu cầu merge được xử lý; trả cờ merged cho biết session có được gộp hay đã được xử lý trước đó.',
    })
    @ApiResponse({
        status: 400,
        description: 'sessionId không phải UUID v4 hợp lệ.',
    })
    @ApiResponse({
        status: 401,
        description: 'Thiếu user identity đã xác thực trong trusted header.',
    })
    async mergeProfile(
        @Headers('x-user-id') userId: string | undefined,
        @Body() body: MergeRecommendationSessionDto,
    ) {
        if (!userId?.trim())
            throw new UnauthorizedException(
                'Authenticated user and guest session are required',
            );
        return this.profile.mergeGuestSession(userId.trim(), body.sessionId);
    }
}
