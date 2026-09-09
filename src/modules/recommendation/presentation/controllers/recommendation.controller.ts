// Controller này là HTTP serving boundary cho Home, Product Detail và trang recommendation; không chứa ranking logic.

import {
  Controller,
  Get,
  Headers,
  Post,
  Body,
  UnauthorizedException,
  Query,
} from "@nestjs/common";
import { RecommendationQueryService } from "../../application/services/query/recommendation-query.service";
import { RecommendationQueryDto } from "../dto/recommendation-query.dto";
import { MergeRecommendationSessionDto } from "../dto/merge-recommendation-session.dto";
import { ProfileQueryService } from "../../../profiles/application/services/profile/profile-query.service";

@Controller("recommendation")
export class RecommendationController {
  constructor(
    private readonly recommendationQuery: RecommendationQueryService,
    private readonly profile: ProfileQueryService,
  ) {}

  // Trả tối đa 24 item đã được backend candidate/ranking/pagination; guest chỉ được xem page đầu.
  @Get("recommendations")
  async getRecommendations(
    @Query() query: RecommendationQueryDto,
    @Headers("x-user-id") userId?: string,
    @Headers("x-session-id") sessionId?: string,
  ) {
    const normalizedUserId = userId?.trim() || null;
    const normalizedSessionId = sessionId?.trim() || null;
    if (!normalizedUserId && !normalizedSessionId)
      throw new UnauthorizedException("A user or guest session is required");
    if (!normalizedUserId && query.page > 1)
      throw new UnauthorizedException({
        code: "LOGIN_REQUIRED_FOR_MORE",
        message: "Đăng nhập để xem thêm sản phẩm gợi ý.",
      });
    return this.recommendationQuery.getRecommendations(
      query,
      normalizedUserId,
      normalizedSessionId,
    );
  }

  // Merge session được Gateway gọi sau login; userId chỉ lấy từ trusted header nên client không thể giả mạo actor đích.
  @Post("profile/merge")
  async mergeProfile(
    @Headers("x-user-id") userId: string | undefined,
    @Body() body: MergeRecommendationSessionDto,
  ) {
    if (!userId?.trim())
      throw new UnauthorizedException(
        "Authenticated user and guest session are required",
      );
    return this.profile.mergeGuestSession(userId.trim(), body.sessionId);
  }
}
