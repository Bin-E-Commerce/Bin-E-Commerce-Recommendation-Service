// HTTP boundary cho Admin Recommendation Center; permission được kiểm tra lại ở đây sau lớp Gateway.

import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Permission } from "@common/auth";
import {
  ActivityQueryDto,
  AnalyticsQueryDto,
  ActorQueryDto,
} from "../dto/analytics-query.dto";
import { UpdateRecommendationPolicyDto } from "../dto/policy.dto";
import { AdminRecommendationService } from "../../application/services/admin-recommendation.service";
import { RecommendationAdminInternalGuard } from "../guards/recommendation-admin-internal.guard";

@ApiTags("Admin - Recommendation")
@Controller("admin/recommendation")
@UseGuards(RecommendationAdminInternalGuard)
export class AdminRecommendationController {
  constructor(private readonly service: AdminRecommendationService) {}

  @Get("overview")
  @ApiOperation({
    summary: "Lấy số liệu tổng quan recommendation",
    description: [
      "Mục đích: cung cấp KPI tổng hợp cho màn hình Admin Recommendation Center, giúp theo dõi hoạt động gợi ý trong một khoảng thời gian.",
      "Đầu vào: query from/to dạng ngày giờ; nếu bỏ trống, mặc định lấy 30 ngày gần nhất. Khoảng thời gian phải tăng dần và không vượt quá 31 ngày.",
      "Kết quả: các số liệu tổng quan và thống kê sản phẩm do repository aggregate từ event recommendation trong khoảng đã chọn.",
      "Quyền truy cập: cần internal token hợp lệ và quyền ADMIN_RECOMMENDATION_ANALYTICS_READ do Gateway chuyển tiếp.",
    ].join("\n\n"),
  })
  @ApiResponse({
    status: 200,
    description: "Các KPI và thống kê tổng quan theo khoảng thời gian.",
  })
  @ApiResponse({
    status: 400,
    description: "Khoảng ngày không hợp lệ hoặc dài hơn 31 ngày.",
  })
  @ApiResponse({
    status: 401,
    description: "Internal token thiếu hoặc không hợp lệ.",
  })
  @ApiResponse({
    status: 403,
    description: "Admin không có quyền đọc analytics recommendation.",
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

  @Get("users")
  @ApiOperation({
    summary: "Tìm các tài khoản/phiên có hoạt động recommendation",
    description: [
      "Mục đích: hiển thị danh sách actor đã phát sinh event để Admin chọn một tài khoản hoặc guest session rồi xem hành trình tương tác.",
      "Đầu vào: from/to (mặc định 30 ngày, tối đa 31 ngày), actorType tùy chọn USER hoặc SESSION, search tùy chọn để tìm thông tin tài khoản, page mặc định 1 và pageSize mặc định 20/tối đa 100.",
      "Kết quả: danh sách actor kèm thống kê hoạt động, thông tin tài khoản nếu phân giải được, tổng số kết quả và thông tin phân trang. Nếu search không tìm được tài khoản, danh sách trả về rỗng.",
      "Quyền truy cập: cần internal token hợp lệ và quyền ADMIN_RECOMMENDATION_ANALYTICS_READ.",
    ].join("\n\n"),
  })
  @ApiResponse({
    status: 200,
    description: "Danh sách actor và thống kê hoạt động có phân trang.",
  })
  @ApiResponse({
    status: 400,
    description: "Khoảng ngày hoặc tham số phân trang không hợp lệ.",
  })
  @ApiResponse({
    status: 401,
    description: "Internal token thiếu hoặc không hợp lệ.",
  })
  @ApiResponse({
    status: 403,
    description: "Admin không có quyền đọc analytics recommendation.",
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

  @Get("users/:userId/activity")
  @ApiOperation({
    summary: "Xem các event recommendation của một tài khoản",
    description: [
      "Mục đích: kiểm tra hành trình gợi ý của một user, gồm các hành động và thông tin attribution liên quan để hỗ trợ phân tích/debug.",
      "Đầu vào: userId trên đường dẫn; from/to (mặc định 30 ngày, tối đa 31 ngày); page mặc định 1 và pageSize mặc định 10/tối đa 50.",
      "Kết quả: các activity event của user theo trang trong khoảng thời gian đã chọn.",
      "Quyền truy cập: cần internal token hợp lệ và quyền ADMIN_RECOMMENDATION_ANALYTICS_READ; không dùng endpoint này để đọc activity của guest session.",
    ].join("\n\n"),
  })
  @ApiParam({
    name: "userId",
    description:
      "ID user đã được Gateway xác thực và ghi nhận trong interaction events.",
  })
  @ApiResponse({
    status: 200,
    description:
      "Trang activity event của user trong khoảng thời gian đã chọn.",
  })
  @ApiResponse({
    status: 400,
    description:
      "userId rỗng, khoảng ngày sai hoặc tham số phân trang không hợp lệ.",
  })
  @ApiResponse({
    status: 401,
    description: "Internal token thiếu hoặc không hợp lệ.",
  })
  @ApiResponse({
    status: 403,
    description: "Admin không có quyền đọc analytics recommendation.",
  })
  async activity(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Param("userId") userId: string,
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

  @Get("config")
  @ApiOperation({
    summary: "Đọc policy ranking đang có hiệu lực",
    description: [
      "Mục đích: cho Admin xem cấu hình mà Recommendation Service hiện đang dùng để xếp hạng sản phẩm.",
      "Đầu vào: không có query hoặc body.",
      "Kết quả: version và trạng thái policy cùng hybridWeights của Standard Ranking, cấu hình AI, trạng thái các candidate source theo ENV, trạng thái model, người cập nhật, lý do và thời điểm. Nếu chưa lưu policy trong database, trả cấu hình runtime mặc định hiện tại.",
      "Quyền truy cập: cần internal token hợp lệ và quyền ADMIN_RECOMMENDATION_POLICY_READ.",
    ].join("\n\n"),
  })
  @ApiResponse({
    status: 200,
    description:
      "Policy đang chạy hoặc cấu hình runtime mặc định nếu chưa có bản được lưu.",
  })
  @ApiResponse({
    status: 401,
    description: "Internal token thiếu hoặc không hợp lệ.",
  })
  @ApiResponse({
    status: 403,
    description: "Admin không có quyền đọc policy recommendation.",
  })
  async config(
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    this.assertPermission(headers, Permission.ADMIN_RECOMMENDATION_POLICY_READ);
    return this.service.getPolicy();
  }

  @Patch("config")
  @ApiOperation({
    summary: "Cập nhật policy ranking",
    description: [
      "Mục đích: thay đổi trọng số Standard Ranking hoặc cấu hình AI-Enhanced Ranking đang áp dụng.",
      "Đầu vào: body patch có thể gồm hybridWeights, mlEnabled, mlBlend (0–0.5) và reason. Khi mlEnabled bật, AI áp dụng cho toàn bộ request; nếu model lỗi hệ thống tự fallback về Standard Ranking. Actor cập nhật được lấy từ trusted x-user-id header.",
      "Xử lý và kết quả: backend kiểm tra key/trọng số, chuẩn hóa tổng trọng số, lưu một version policy mới rồi cập nhật runtime; response trả version, config và metadata lưu.",
      "Quyền truy cập: cần internal token hợp lệ và quyền ADMIN_RECOMMENDATION_POLICY_WRITE. Cấu hình sai hoặc tổng trọng số không hợp lệ bị từ chối, không thay policy đang chạy.",
    ].join("\n\n"),
  })
  @ApiResponse({
    status: 200,
    description:
      "Policy mới đã lưu và được áp dụng; trả version cùng cấu hình đã chuẩn hóa.",
  })
  @ApiResponse({
    status: 400,
    description:
      "Weight/key hoặc ML blend không hợp lệ; policy hiện tại không bị thay đổi.",
  })
  @ApiResponse({
    status: 401,
    description:
      "Internal token thiếu/không hợp lệ hoặc thiếu user identity của Admin.",
  })
  @ApiResponse({
    status: 403,
    description: "Admin không có quyền cập nhật policy recommendation.",
  })
  async updateConfig(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Body() body: UpdateRecommendationPolicyDto,
  ) {
    this.assertPermission(
      headers,
      Permission.ADMIN_RECOMMENDATION_POLICY_WRITE,
    );
    return this.service.updatePolicy(body, this.requireUserId(headers));
  }

  @Get("config/history")
  @ApiOperation({
    summary: "Xem lịch sử các phiên bản policy",
    description: [
      "Mục đích: audit các lần thay đổi cấu hình ranking và xác định version có thể dùng làm mốc rollback.",
      "Đầu vào: không có query hoặc body.",
      "Kết quả: tối đa 50 phiên bản gần nhất, gồm version, trạng thái, config, người thay đổi, lý do và thời điểm tạo; endpoint chỉ đọc, không thay đổi policy runtime.",
      "Quyền truy cập: cần internal token hợp lệ và quyền ADMIN_RECOMMENDATION_POLICY_READ.",
    ].join("\n\n"),
  })
  @ApiResponse({
    status: 200,
    description: "Danh sách tối đa 50 phiên bản policy gần nhất.",
  })
  @ApiResponse({
    status: 401,
    description: "Internal token thiếu hoặc không hợp lệ.",
  })
  @ApiResponse({
    status: 403,
    description: "Admin không có quyền đọc lịch sử policy.",
  })
  async configHistory(
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    this.assertPermission(headers, Permission.ADMIN_RECOMMENDATION_POLICY_READ);
    return this.service.getPolicyHistory();
  }

  @Post("config/rollback/:version")
  @ApiOperation({
    summary: "Khôi phục cấu hình từ một phiên bản policy cũ",
    description: [
      "Mục đích: đưa cấu hình của một version trong lịch sử trở lại runtime khi policy mới gây kết quả không mong muốn.",
      "Đầu vào: version cần khôi phục trên đường dẫn; actor thực hiện lấy từ trusted x-user-id header.",
      "Xử lý và kết quả: backend tạo một version rollback mới từ config cũ, lưu và áp dụng nó. Bản lịch sử cũ không bị sửa/xóa; response cho biết version mới và version được khôi phục.",
      "Quyền truy cập: cần internal token hợp lệ và quyền ADMIN_RECOMMENDATION_POLICY_ROLLBACK. Version không còn trong lịch sử được báo 404.",
    ].join("\n\n"),
  })
  @ApiParam({
    name: "version",
    description: "Mã version policy cũ cần khôi phục.",
  })
  @ApiResponse({
    status: 201,
    description: "Đã tạo và áp dụng một version rollback mới.",
  })
  @ApiResponse({
    status: 401,
    description:
      "Internal token thiếu/không hợp lệ hoặc thiếu user identity của Admin.",
  })
  @ApiResponse({
    status: 403,
    description: "Admin không có quyền rollback policy recommendation.",
  })
  @ApiResponse({
    status: 404,
    description:
      "Không tìm thấy version policy trong lịch sử được phép tra cứu.",
  })
  async rollback(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Param("version") version: string,
  ) {
    this.assertPermission(
      headers,
      Permission.ADMIN_RECOMMENDATION_POLICY_ROLLBACK,
    );
    return this.service.rollbackPolicy(version, this.requireUserId(headers));
  }

  @Get("ranking-performance")
  @ApiOperation({
    summary: "Đọc hiệu quả theo ranking mode",
    description: [
      "Mục đích: theo dõi dữ liệu attribution theo ranking mode thực tế để biết AI và Standard/Fallback đang tạo ra bao nhiêu impression, click và hành động liên quan.",
      "Đầu vào: from/to dạng ngày giờ; mặc định lấy 30 ngày gần nhất và giới hạn tối đa 31 ngày.",
      "Kết quả: số liệu aggregate từ toàn bộ event có recommendation attribution trong khoảng đã chọn, nhóm theo ranking mode; endpoint không chia traffic và không tự sinh dữ liệu thử nghiệm.",
      "Quyền truy cập: cần internal token hợp lệ và quyền ADMIN_RECOMMENDATION_ANALYTICS_READ.",
    ].join("\n\n"),
  })
  @ApiResponse({
    status: 200,
    description:
      "Các số liệu ranking performance aggregate trong khoảng thời gian đã chọn.",
  })
  @ApiResponse({
    status: 400,
    description: "Khoảng ngày không hợp lệ hoặc dài hơn 31 ngày.",
  })
  @ApiResponse({
    status: 401,
    description: "Internal token thiếu hoặc không hợp lệ.",
  })
  @ApiResponse({
    status: 403,
    description: "Admin không có quyền đọc analytics recommendation.",
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
    if (from >= to) throw new BadRequestException("Invalid analytics range");
    if (to.getTime() - from.getTime() > 31 * 86_400_000) {
      throw new BadRequestException("Analytics range is limited to 31 days");
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
    const raw = headers["x-user-permissions"];
    const values = (Array.isArray(raw) ? raw.join(",") : (raw ?? ""))
      .split(",")
      .map((value) => value.trim());
    if (!values.includes(permission)) {
      throw new ForbiddenException("Missing recommendation admin permission");
    }
  }

  private requireUserId(
    headers: Record<string, string | string[] | undefined>,
  ): string {
    const raw = headers["x-user-id"];
    const userId = Array.isArray(raw) ? raw[0] : raw;
    if (!userId?.trim())
      throw new UnauthorizedException("Authenticated admin is required");
    return userId.trim();
  }
}
