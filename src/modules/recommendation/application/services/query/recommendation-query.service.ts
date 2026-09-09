// Service này điều phối recommendation request: đọc context/profile, gom candidate, cache và phân trang; ranking nằm ở policy riêng.

import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { ProfileQueryService } from "../../../../profiles/application/services/profile/profile-query.service";
import { SessionContextService } from "../../../../profiles/application/services/session/session-context.service";
import { RecommendationRedisService } from "../../../../../infrastructure/redis/redis.module";
import type { RecommendationQueryDto } from "../../../presentation/dto/recommendation-query.dto";
import type {
  RecommendationItemResponse,
  RecommendationResponse,
  RecommendationStrategy,
} from "../../types/recommendation.types";
import {
  RecommendationRankingService,
  type RecommendationCandidate,
} from "../ranking/recommendation-ranking.service";
import { CandidateUnionService } from "../candidates/candidate-union.service";
import { CandidateGenerationService } from "../candidates/candidate-generation.service";
import type { CandidateSourceResult } from "../candidates/candidate-source";

@Injectable()
export class RecommendationQueryService {
  constructor(
    private readonly profile: ProfileQueryService,
    private readonly session: SessionContextService,
    private readonly redis: RecommendationRedisService,
    private readonly ranking: RecommendationRankingService,
    private readonly unionFactory: CandidateUnionService,
    private readonly candidates: CandidateGenerationService,
  ) {}

  // Trả recommendation theo actor context, ưu tiên cache versioned rồi mới dựng candidate pool để backend kiểm soát pagination.
  async getRecommendations(
    input: RecommendationQueryDto,
    userId: string | null,
    sessionId: string | null,
  ): Promise<RecommendationResponse> {
    const actorType = userId ? "user" : "session";
    const actorId = userId ?? sessionId ?? "anonymous";
    const pageSize =
      input.surface === "product_detail"
        ? Math.min(input.pageSize, 6)
        : input.pageSize;
    const [globalVersion, actorVersion] = await Promise.all([
      this.redis.getVersion("recommendation:cache-version:global"),
      this.redis.getVersion(
        `recommendation:cache-version:${actorType}:${actorId}`,
      ),
    ]);
    const ruleVersion = encodeURIComponent(this.ranking.getRuleVersion());
    const cacheKey = `recommendation:v${globalVersion}:r${ruleVersion}:a${actorVersion}:${actorType}:${actorId}:${sessionId ?? "none"}:${input.surface}:${input.productId ?? "none"}:${input.page}:${pageSize}`;
    const cached = await this.redis.getJson<RecommendationResponse>(cacheKey);
    if (cached) return cached;

    const context = sessionId ? await this.session.get(sessionId) : null;
    const result = await this.buildResponse(
      input,
      userId,
      sessionId,
      context,
      pageSize,
    );
    await this.redis.setJson(cacheKey, result, 300);
    return result;
  }

  // Gom source candidate bằng các query song song; duplicate product chỉ giữ một read model và hợp nhất source để explainability.
  private async buildResponse(
    input: RecommendationQueryDto,
    userId: string | null,
    sessionId: string | null,
    context: Awaited<ReturnType<SessionContextService["get"]>>,
    pageSize: number,
  ): Promise<RecommendationResponse> {
    const actorType = userId ? "USER" : "SESSION";
    const actorId = userId ?? sessionId ?? "anonymous";
    const [productPreferences, categoryPreferences, brandPreferences] =
      await Promise.all([
        this.profile.getTop(actorType, actorId, "PRODUCT", 30),
        this.profile.getTop(actorType, actorId, "CATEGORY", 12),
        this.profile.getTop(actorType, actorId, "BRAND", 12),
      ]);
    const profileProductIds = productPreferences.map(
      (item) => item.dimensionKey,
    );
    const categoryIds = [
      ...new Set([
        ...categoryPreferences.map((item) => item.dimensionKey),
        ...(context?.recentCategoryIds ?? []),
      ]),
    ].filter(Boolean);
    const brandIds = [
      ...new Set([
        ...brandPreferences.map((item) => item.dimensionKey),
        ...(context?.recentBrandIds ?? []),
      ]),
    ].filter(Boolean);
    const excluded = new Set(
      [
        input.productId,
        ...(context?.recentProductIds ?? []).slice(0, 3),
      ].filter(Boolean) as string[],
    );

    const union = this.unionFactory.create([...excluded], 300);
    const sourceResults = await this.candidates.generate({
      productId: input.productId,
      excludedProductIds: [...excluded],
      profileProductIds,
      categoryIds,
      brandIds,
      recentProductIds: context?.recentProductIds ?? [],
    });
    for (const result of sourceResults) this.addSource(union, result);

    const strategy: RecommendationStrategy =
      productPreferences.length ||
      categoryPreferences.length ||
      brandPreferences.length
        ? "PERSONALIZED"
        : context
          ? "SESSION_BASED"
          : "COLD_START";
    // Giới hạn candidate union trước ranking để request miss không làm phình CPU/DB khi nhiều source cùng trả dữ liệu.
    const candidatePool = union.values();
    const diversified = this.ranking.rank(
      candidatePool,
      productPreferences,
      categoryPreferences,
      brandPreferences,
      context,
      strategy,
    );
    const total = diversified.length;
    const start = (input.page - 1) * pageSize;
    const pageItems = diversified.slice(start, start + pageSize);
    const requestId = randomUUID();

    return {
      requestId,
      strategy,
      profileState: userId
        ? productPreferences.length || categoryPreferences.length
          ? "USER"
          : "NEW_USER"
        : "GUEST",
      items: pageItems.map((item, index) =>
        this.toResponseItem(item, start + index + 1),
      ),
      page: input.page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
      generatedAt: new Date().toISOString(),
      ruleVersion: this.ranking.getRuleVersion(),
    };
  }

  // Dua ket qua source vao union tai mot diem duy nhat de query service chi con dieu phoi response/pagination.
  private addSource(
    union: ReturnType<CandidateUnionService["create"]>,
    result: CandidateSourceResult,
  ): void {
    union.add(result.products, result.source, result.contributionByProductId);
  }

  // Chuyển read model thành product card contract và hiển thị reason theo source mạnh nhất; raw score vẫn giữ cho debug/UI hiện tại.
  private toResponseItem(
    item: RecommendationCandidate & { score: number },
    rank: number,
  ): RecommendationItemResponse {
    const sourcePriority = [
      "PRODUCT_AFFINITY",
      "CATEGORY_AFFINITY",
      "BRAND_AFFINITY",
      "TRENDING",
      "BEST_SELLING",
      "NEWEST",
      "EXPLORE",
      "SEMANTIC_SIMILARITY",
      "CO_BEHAVIOR",
    ];
    const source =
      sourcePriority.find((candidateSource) =>
        item.sources.has(candidateSource),
      ) ?? "EXPLORE";
    const reasonBySource: Record<string, string> = {
      PRODUCT_AFFINITY: "Dựa trên sản phẩm bạn từng quan tâm",
      CATEGORY_AFFINITY: "Phù hợp với danh mục bạn đang quan tâm",
      BRAND_AFFINITY: "Được chọn theo thương hiệu bạn yêu thích",
      TRENDING: "Đang được nhiều người quan tâm",
      BEST_SELLING: "Được nhiều khách hàng lựa chọn",
      NEWEST: "Sản phẩm mới đáng để khám phá",
      EXPLORE: "Một lựa chọn mới để bạn khám phá",
      SEMANTIC_SIMILARITY: "Có nội dung tương đồng với sản phẩm bạn quan tâm",
      CO_BEHAVIOR: "Được chọn từ hành vi mua sắm tương tự",
    };
    return {
      product: {
        id: item.product.productId,
        originType: item.product.originType,
        name: item.product.name,
        slug: item.product.slug,
        sellerShopId: item.product.sellerShopId,
        categoryId: item.product.categoryId,
        minPrice: item.product.minPrice,
        maxPrice: item.product.maxPrice,
        displayPrice: item.product.minPrice,
        displayOriginalPrice: null,
        totalSold: item.product.totalSold,
        ratingAvg: item.product.ratingAvg,
        reviewCount: item.product.reviewCount,
        images: item.product.imageUrl
          ? [
              {
                id: `${item.product.productId}-thumbnail`,
                imageUrl: item.product.imageUrl,
                sortOrder: 0,
                isThumbnail: true,
              },
            ]
          : [],
        externalShop: null,
        brand: null,
      },
      rank,
      score: Number(item.score.toFixed(6)),
      source,
      reasons: [reasonBySource[source] ?? "Một lựa chọn đáng để bạn khám phá"],
    };
  }
}
