// HTTP boundary cho Admin Recommendation Center; permission được kiểm tra lại ở đây sau lớp Gateway.

import {
    Controller,
    Get,
    Headers,
    Param,
    Query,
    BadRequestException,
    ForbiddenException,
    UnauthorizedException,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Permission } from '@common/auth';
import { InternalServiceTokenGuard } from '@/common/security/internal-service-token.guard';
import {
    ActivityQueryDto,
    AnalyticsQueryDto,
    ActorQueryDto,
} from '@/modules/admin-recommendation/presentation/dto/analytics-query.dto';
import { AdminRecommendationService } from '@/modules/admin-recommendation/application/services/admin-recommendation.service';

@ApiTags('Admin - Recommendation')
@Controller('admin/recommendation')
@UseGuards(InternalServiceTokenGuard)
export class AdminRecommendationController {
    constructor(private readonly service: AdminRecommendationService) {}

    @Get('overview')
    @ApiOperation({
        summary: 'Lấy số liệu tổng quan recommendation',
        description: [
            'Mục đích: cung cấp KPI tổng hợp cho màn hình Admin Recommendation Center, giúp theo dõi hoạt động gợi ý trong một khoảng thời gian.',
            'Đầu vào: query from/to dạng ngày giờ; nếu bỏ trống, mặc định lấy 30 ngày gần nhất. Khoảng thời gian phải tăng dần và không vượt quá 31 ngày.',
            'Kết quả: các số liệu tổng quan và thống kê sản phẩm do repository aggregate từ event recommendation trong khoảng đã chọn.',
            'Quyền truy cập: cần internal token hợp lệ và quyền ADMIN_RECOMMENDATION_ANALYTICS_READ do Gateway chuyển tiếp.',
        ].join('\n\n'),
    })
    @ApiResponse({
        status: 200,
        description: 'Các KPI và thống kê tổng quan theo khoảng thời gian.',
    })
    @ApiResponse({
        status: 400,
        description: 'Khoảng ngày không hợp lệ hoặc dài hơn 31 ngày.',
    })
    @ApiResponse({
        status: 401,
        description: 'Internal token thiếu hoặc không hợp lệ.',
    })
    @ApiResponse({
        status: 403,
        description: 'Admin không có quyền đọc analytics recommendation.',
    })
    async overview(
        @Headers() headers: Record<string, string | string[] | undefined>,
        @Query() query: AnalyticsQueryDto,
    ) {
        this.assertPermission(
            headers,
            Permission.ADMIN_RECOMMENDATION_ANALYTICS_READ,
        );
        const range = this.normalizeRange(query);
        return this.service.getOverview(range);
    }

    @Get('users')
    @ApiOperation({
        summary: 'Tìm các tài khoản/phiên có hoạt động recommendation',
        description: [
            'Mục đích: hiển thị danh sách actor đã phát sinh event để Admin chọn một tài khoản hoặc guest session rồi xem hành trình tương tác.',
            'Đầu vào: from/to (mặc định 30 ngày, tối đa 31 ngày), actorType tùy chọn USER hoặc SESSION, search tùy chọn để tìm thông tin tài khoản, page mặc định 1 và pageSize mặc định 20/tối đa 100.',
            'Kết quả: danh sách actor kèm thống kê hoạt động, thông tin tài khoản nếu phân giải được, tổng số kết quả và thông tin phân trang. Nếu search không tìm được tài khoản, danh sách trả về rỗng.',
            'Quyền truy cập: cần internal token hợp lệ và quyền ADMIN_RECOMMENDATION_ANALYTICS_READ.',
        ].join('\n\n'),
    })
    @ApiResponse({
        status: 200,
        description: 'Danh sách actor và thống kê hoạt động có phân trang.',
    })
    @ApiResponse({
        status: 400,
        description: 'Khoảng ngày hoặc tham số phân trang không hợp lệ.',
    })
    @ApiResponse({
        status: 401,
        description: 'Internal token thiếu hoặc không hợp lệ.',
    })
    @ApiResponse({
        status: 403,
        description: 'Admin không có quyền đọc analytics recommendation.',
    })
    async users(
        @Headers() headers: Record<string, string | string[] | undefined>,
        @Query() query: ActorQueryDto,
    ) {
        this.assertPermission(
            headers,
            Permission.ADMIN_RECOMMENDATION_ANALYTICS_READ,
        );
        return this.service.listActors(this.normalizeActorQuery(query));
    }

    @Get('users/:userId/activity')
    @ApiOperation({
        summary: 'Xem các event recommendation của một tài khoản',
        description: [
            'Mục đích: kiểm tra hành trình gợi ý của một user, gồm các hành động và thông tin attribution liên quan để hỗ trợ phân tích/debug.',
            'Đầu vào: userId trên đường dẫn; from/to (mặc định 30 ngày, tối đa 31 ngày); page mặc định 1 và pageSize mặc định 10/tối đa 50.',
            'Kết quả: các activity event của user theo trang trong khoảng thời gian đã chọn.',
            'Quyền truy cập: cần internal token hợp lệ và quyền ADMIN_RECOMMENDATION_ANALYTICS_READ; không dùng endpoint này để đọc activity của guest session.',
        ].join('\n\n'),
    })
    @ApiParam({
        name: 'userId',
        description:
            'ID user đã được Gateway xác thực và ghi nhận trong interaction events.',
    })
    @ApiResponse({
        status: 200,
        description:
            'Trang activity event của user trong khoảng thời gian đã chọn.',
    })
    @ApiResponse({
        status: 400,
        description:
            'userId rỗng, khoảng ngày sai hoặc tham số phân trang không hợp lệ.',
    })
    @ApiResponse({
        status: 401,
        description: 'Internal token thiếu hoặc không hợp lệ.',
    })
    @ApiResponse({
        status: 403,
        description: 'Admin không có quyền đọc analytics recommendation.',
    })
    async activity(
        @Headers() headers: Record<string, string | string[] | undefined>,
        @Param('userId') userId: string,
        @Query() query: ActivityQueryDto,
    ) {
        this.assertPermission(
            headers,
            Permission.ADMIN_RECOMMENDATION_ANALYTICS_READ,
        );
        return this.service.getUserActivity(
            userId,
            query.page,
            query.pageSize,
            this.normalizeRange(query),
        );
    }

    @Get('config')
    @ApiOperation({
        summary: 'Đọc trạng thái model ranking đang phục vụ',
        description: [
            'Mục đích: cho Admin xác nhận Recommendation Service chỉ dùng model LambdaRank và xem artifact có sẵn sàng hay không.',
            'Đầu vào: không có query hoặc body.',
            'Kết quả: rankingMode, objective, version, trạng thái candidate source và trạng thái artifact LambdaRank. Endpoint không trả hoặc nhận trọng số Standard/AI blend.',
            'Quyền truy cập: cần internal token hợp lệ và quyền ADMIN_RECOMMENDATION_POLICY_READ.',
        ].join('\n\n'),
    })
    @ApiResponse({
        status: 200,
        description: 'Trạng thái model LambdaRank và các candidate source.',
    })
    @ApiResponse({
        status: 401,
        description: 'Internal token thiếu hoặc không hợp lệ.',
    })
    @ApiResponse({
        status: 403,
        description: 'Admin không có quyền đọc policy recommendation.',
    })
    async config(
        @Headers() headers: Record<string, string | string[] | undefined>,
    ) {
        this.assertPermission(
            headers,
            Permission.ADMIN_RECOMMENDATION_POLICY_READ,
        );
        return this.service.getPolicy();
    }

    @Get('config/history')
    @ApiOperation({
        summary: 'Xem lịch sử các phiên bản policy',
        description: [
            'Mục đích: audit các lần thay đổi cấu hình ranking và xác định version có thể dùng làm mốc rollback.',
            'Đầu vào: không có query hoặc body.',
            'Kết quả: tối đa 50 phiên bản gần nhất, gồm version, trạng thái, config, người thay đổi, lý do và thời điểm tạo; endpoint chỉ đọc, không thay đổi policy runtime.',
            'Quyền truy cập: cần internal token hợp lệ và quyền ADMIN_RECOMMENDATION_POLICY_READ.',
        ].join('\n\n'),
    })
    @ApiResponse({
        status: 200,
        description: 'Danh sách tối đa 50 phiên bản policy gần nhất.',
    })
    @ApiResponse({
        status: 401,
        description: 'Internal token thiếu hoặc không hợp lệ.',
    })
    @ApiResponse({
        status: 403,
        description: 'Admin không có quyền đọc lịch sử policy.',
    })
    async configHistory(
        @Headers() headers: Record<string, string | string[] | undefined>,
    ) {
        this.assertPermission(
            headers,
            Permission.ADMIN_RECOMMENDATION_POLICY_READ,
        );
        return this.service.getPolicyHistory();
    }

    @Get('ranking-performance')
    @ApiOperation({
        summary: 'Đọc hiệu quả theo ranking mode',
        description: [
            'Mục đích: theo dõi impression, click và hành động theo ranking mode được ghi trên từng sự kiện attribution; giá trị cũ chỉ xuất hiện nếu còn event lịch sử.',
            'Đầu vào: from/to dạng ngày giờ; mặc định lấy 30 ngày gần nhất và giới hạn tối đa 31 ngày.',
            'Kết quả: số liệu aggregate từ toàn bộ event có recommendation attribution trong khoảng đã chọn, nhóm theo ranking mode; endpoint không chia traffic và không tự sinh dữ liệu thử nghiệm.',
            'Quyền truy cập: cần internal token hợp lệ và quyền ADMIN_RECOMMENDATION_ANALYTICS_READ.',
        ].join('\n\n'),
    })
    @ApiResponse({
        status: 200,
        description:
            'Các số liệu ranking performance aggregate trong khoảng thời gian đã chọn.',
    })
    @ApiResponse({
        status: 400,
        description: 'Khoảng ngày không hợp lệ hoặc dài hơn 31 ngày.',
    })
    @ApiResponse({
        status: 401,
        description: 'Internal token thiếu hoặc không hợp lệ.',
    })
    @ApiResponse({
        status: 403,
        description: 'Admin không có quyền đọc analytics recommendation.',
    })
    async rankingPerformance(
        @Headers() headers: Record<string, string | string[] | undefined>,
        @Query() query: AnalyticsQueryDto,
    ) {
        this.assertPermission(
            headers,
            Permission.ADMIN_RECOMMENDATION_ANALYTICS_READ,
        );
        const range = this.normalizeRange(query);
        return this.service.getRankingPerformance(range.from, range.to);
    }

    // Mặc định lấy 30 ngày gần nhất; giới hạn tối đa 31 ngày để bảo vệ DB khi Admin mở dashboard.
    private normalizeRange(query: AnalyticsQueryDto) {
        const to = query.to ?? new Date();
        const from = query.from ?? new Date(to.getTime() - 30 * 86_400_000);
        if (from >= to)
            throw new BadRequestException('Invalid analytics range');
        if (to.getTime() - from.getTime() > 31 * 86_400_000) {
            throw new BadRequestException(
                'Analytics range is limited to 31 days',
            );
        }
        return { from, to };
    }

    // Actor query dùng chung range validation và giữ pagination bounded trước khi đi vào SQL.
    private normalizeActorQuery(query: ActorQueryDto) {
        return {
            ...this.normalizeRange(query),
            page: query.page,
            pageSize: query.pageSize,
            actorType: query.actorType,
            search: query.search,
        };
    }

    // Header permission do Gateway inject; direct call thiếu permission bị chặn ngay tại service boundary.
    private assertPermission(
        headers: Record<string, string | string[] | undefined>,
        permission: string,
    ): void {
        const raw = headers['x-user-permissions'];
        const values = (Array.isArray(raw) ? raw.join(',') : (raw ?? ''))
            .split(',')
            .map((value) => value.trim());
        if (!values.includes(permission)) {
            throw new ForbiddenException(
                'Missing recommendation admin permission',
            );
        }
    }

    private requireUserId(
        headers: Record<string, string | string[] | undefined>,
    ): string {
        const raw = headers['x-user-id'];
        const userId = Array.isArray(raw) ? raw[0] : raw;
        if (!userId?.trim())
            throw new UnauthorizedException('Authenticated admin is required');
        return userId.trim();
    }
}
