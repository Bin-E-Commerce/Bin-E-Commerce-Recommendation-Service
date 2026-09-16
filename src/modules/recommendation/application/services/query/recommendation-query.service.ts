// Service này điều phối recommendation request: đọc context/profile, gom candidate, cache và phân trang; ranking nằm ở policy riêng.

import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
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
import { RecommendationRankingService } from "../ranking/policy/recommendation-ranking.service";
import type {
  RecommendationCandidate,
  RankingMode,
} from "../../types/ranking/ranking.types";
import { CandidateUnionService } from "../candidates/union/candidate-union.service";
import { CandidateGenerationService } from "../candidates/generation/candidate-generation.service";
import type { CandidateSourceResult } from "../../types/candidates/candidate-source.types";
import { RecommendationTrackingTokenService } from "../tracking/attribution/recommendation-tracking-token.service";
import { RecommendationMlRankingService } from "../ranking/ml/recommendation-ml-ranking.service";
import { CatalogService } from "../../../../catalog/application/services/catalog/catalog.service";
import type { RecommendationCatalogProduct } from "../../../../catalog/application/types/catalog-product.type";

@Injectable()
export class RecommendationQueryService {
  private readonly cacheTtlSeconds: number;

  constructor(
    private readonly config: ConfigService,
    private readonly profile: ProfileQueryService,
    private readonly session: SessionContextService,
    private readonly redis: RecommendationRedisService,
    private readonly ranking: RecommendationRankingService,
    private readonly unionFactory: CandidateUnionService,
    private readonly candidates: CandidateGenerationService,
    private readonly trackingToken: RecommendationTrackingTokenService,
    private readonly mlRanking: RecommendationMlRankingService,
    private readonly catalog: CatalogService,
  ) {
    const configuredTtl = Number(
      this.config.get<string>("RECOMMENDATION_CACHE_TTL_SECONDS", "300"),
    );
    this.cacheTtlSeconds = Number.isFinite(configuredTtl)
      ? Math.min(Math.max(Math.trunc(configuredTtl), 30), 3600)
      : 300;
  }

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
        ? Math.min(input.pageSize, 24)
        : input.pageSize;
    // AI bật thì mọi actor đều được thử model; Standard chỉ là mode tắt AI hoặc fallback khi model không hợp lệ.
    const mode: RankingMode = this.ranking.isMlRankingEnabled()
      ? "ML_HYBRID"
      : "HYBRID";
    const policyVersion = this.ranking.getPolicyVersion(mode);
    const [globalVersion, actorVersion] = await Promise.all([
      this.redis.getVersion("recommendation:cache-version:global"),
      this.redis.getVersion(
        `recommendation:cache-version:${actorType}:${actorId}`,
      ),
    ]);
    const ruleVersion = encodeURIComponent(policyVersion);
    const cacheKey = `recommendation:contract-v5:v${globalVersion}:r${ruleVersion}:m${mode}:a${actorVersion}:${actorType}:${actorId}:${sessionId ?? "none"}:${input.surface}:${input.productId ?? "none"}:${input.page}:${pageSize}`;
    const cached = await this.redis.getJson<RecommendationResponse>(cacheKey);
    if (cached) {
      const response = this.refreshCachedResponse(
        cached,
        actorId,
        input.surface,
      );
      return response;
    }

    const context = sessionId ? await this.session.get(sessionId) : null;
    const result = await this.buildResponse(
      input,
      userId,
      sessionId,
      context,
      pageSize,
      mode,
    );
    await this.redis.setJson(cacheKey, result.response, this.cacheTtlSeconds);
    return result.response;
  }

  // Tạo request/token mới cho mỗi HTTP response để cache hit không làm gộp impression của nhiều lần serving vào một requestId.
  private refreshCachedResponse(
    cached: RecommendationResponse,
    actorId: string,
    surface: RecommendationQueryDto["surface"],
  ): RecommendationResponse {
    const requestId = randomUUID();
    const rankingMode: RankingMode =
      cached.rankingMode ??
      (cached.rankingModelVersion ? "ML_HYBRID" : "HYBRID");
    return {
      ...cached,
      requestId,
      generatedAt: new Date().toISOString(),
      // Cache cũ có thể chưa có field rankingMode; suy luận an toàn từ model version để response contract luôn đầy đủ.
      rankingMode,
      rankingModelVersion: cached.rankingModelVersion ?? null,
      items: cached.items.map((item) => ({
        ...item,
        recommendationItemId: this.trackingToken.create({
          actorId,
          requestId,
          productId: item.product.id,
          rank: item.rank,
          source: item.source,
          surface,
          policyVersion:
            cached.rankingPolicyVersion ??
            this.ranking.getPolicyVersion(rankingMode),
          rankingMode,
        }),
      })),
    };
  }

  // Gom source candidate bằng các query song song; duplicate product chỉ giữ một read model và hợp nhất source để explainability.
  // Với product detail, snapshot được đọc trước để xác định đúng namespace shop rồi truyền exclusion xuống từng source và union.
  // Với home/recommendations_page, recentProductIds không bị loại vì chúng vẫn là anchor cho semantic/co-behavior ranking.
  // Mọi source vẫn fail-soft ở CandidateGenerationService, còn snapshot lỗi chỉ làm mất shop exclusion chứ không làm mất response.
  private async buildResponse(
    input: RecommendationQueryDto,
    userId: string | null,
    sessionId: string | null,
    context: Awaited<ReturnType<SessionContextService["get"]>>,
    pageSize: number,
    mode: RankingMode,
  ): Promise<{
    response: RecommendationResponse;
  }> {
    const actorType = userId ? "USER" : "SESSION";
    const actorId = userId ?? sessionId ?? "anonymous";
    const [productPreferences, categoryPreferences, brandPreferences] =
      await Promise.all([
        this.profile.getTop(actorType, actorId, "PRODUCT", 30),
        this.profile.getTop(actorType, actorId, "CATEGORY", 12),
        this.profile.getTop(actorType, actorId, "BRAND", 12),
      ]);
    const profileProductIds = productPreferences
      .filter((item) => item.score > 0)
      .map((item) => item.dimensionKey);
    const categoryIds = [
      ...new Set([
        ...categoryPreferences
          .filter((item) => item.score > 0)
          .map((item) => item.dimensionKey),
        ...(context?.recentCategoryIds ?? []),
      ]),
    ].filter(Boolean);
    const brandIds = [
      ...new Set([
        ...brandPreferences
          .filter((item) => item.score > 0)
          .map((item) => item.dimensionKey),
        ...(context?.recentBrandIds ?? []),
      ]),
    ].filter(Boolean);
    // Recent products là anchor để tìm semantic/co-behavior, không phải exclusion mặc định;
    // chỉ product đang mở bị loại ở product detail để tránh lặp chính nó trên carousel.
    const excluded = new Set(
      (input.surface === "product_detail" ? [input.productId] : []).filter(
        Boolean,
      ) as string[],
    );
    let currentProduct: RecommendationCatalogProduct | null = null;
    if (input.surface === "product_detail" && input.productId) {
      try {
        currentProduct =
          (await this.catalog.findSnapshots([input.productId]))[0] ?? null;
      } catch {
        // Snapshot lỗi chỉ bỏ shop exclusion; exclusion productId vẫn giữ để recommendation không lặp chính sản phẩm.
        currentProduct = null;
      }
    }
    const shopExclusions = {
      ...(currentProduct?.sellerShopId
        ? { excludeSellerShopId: currentProduct.sellerShopId }
        : {}),
      ...(currentProduct?.externalShopId
        ? { excludeExternalShopId: currentProduct.externalShopId }
        : {}),
    };
    const strategy: RecommendationStrategy =
      productPreferences.some((item) => item.score > 0) ||
      categoryPreferences.some((item) => item.score > 0) ||
      brandPreferences.some((item) => item.score > 0)
        ? "PERSONALIZED"
        : context
          ? "SESSION_BASED"
          : "COLD_START";

    const union = this.unionFactory.create([...excluded], 300, shopExclusions);
    const sourceResults = await this.candidates.generate({
      productId: input.productId,
      excludedProductIds: [...excluded],
      excludedSellerShopId: shopExclusions.excludeSellerShopId,
      excludedExternalShopId: shopExclusions.excludeExternalShopId,
      profileProductIds,
      categoryIds,
      brandIds,
      recentProductIds: context?.recentProductIds ?? [],
      recentProductSignals: context?.recentProductSignals ?? [],
      strategy,
    });
    for (const result of sourceResults) this.addSource(union, result);

    // Giới hạn candidate union trước ranking để request miss không làm phình CPU/DB khi nhiều source cùng trả dữ liệu.
    const candidatePool = union.values();
    const mlResult =
      mode === "ML_HYBRID"
        ? await this.mlRanking.predict({
            requestId: randomUUID(),
            candidates: candidatePool,
            products: productPreferences,
            categories: categoryPreferences,
            brands: brandPreferences,
            context,
          })
        : {
            scores: new Map<string, number>(),
            features: new Map(),
            modelVersion: null,
          };
    // ML fail-soft phải hạ mode về Standard để analytics phản ánh đúng mode thực sự đã phục vụ.
    const servingMode: RankingMode =
      mode === "ML_HYBRID" && !mlResult.modelVersion ? "HYBRID" : mode;
    const diversified = this.ranking.rank(
      candidatePool,
      productPreferences,
      categoryPreferences,
      brandPreferences,
      context,
      strategy,
      {
        mode: servingMode,
        surface: input.surface,
        mlScores: mlResult.scores,
        mlFeatures: mlResult.features,
      },
    );
    const total = diversified.length;
    const start = (input.page - 1) * pageSize;
    const pageItems = diversified.slice(start, start + pageSize);
    const requestId = randomUUID();
    const hasPositiveProfileSignal = [
      ...productPreferences,
      ...categoryPreferences,
      ...brandPreferences,
    ].some((item) => item.score > 0);

    const response: RecommendationResponse = {
      requestId,
      strategy,
      // Negative/returned signals vẫn được lưu để tránh gợi ý sai,
      // nhưng không có nghĩa user đã có positive preference để gọi là personalized.
      profileState: userId
        ? hasPositiveProfileSignal
          ? "USER"
          : "NEW_USER"
        : "GUEST",
      items: pageItems.map((item, index) =>
        this.toResponseItem(
          item,
          start + index + 1,
          requestId,
          actorId,
          input.surface,
          servingMode,
        ),
      ),
      page: input.page,
      pageSize,
      total,
      totalPages: total === 0 ? 1 : Math.ceil(total / pageSize),
      generatedAt: new Date().toISOString(),
      ruleVersion: this.ranking.getRuleVersion(),
      rankingPolicyVersion: this.ranking.getPolicyVersion(servingMode),
      rankingMode: servingMode,
      rankingModelVersion: mlResult.modelVersion,
    };
    return { response };
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
    requestId: string,
    actorId: string,
    surface: RecommendationQueryDto["surface"],
    mode: RankingMode,
  ): RecommendationItemResponse {
    const sourcePriority = [
      "PRODUCT_AFFINITY",
      "CATEGORY_AFFINITY",
      "BRAND_AFFINITY",
      "CO_BEHAVIOR",
      "SEMANTIC_SIMILARITY",
      "TRENDING",
      "BEST_SELLING",
      "NEWEST",
      "EXPLORE",
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
        externalShopId: item.product.externalShopId,
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
      recommendationItemId: this.trackingToken.create({
        actorId,
        requestId,
        productId: item.product.productId,
        rank,
        source,
        surface,
        policyVersion: this.ranking.getPolicyVersion(mode),
        rankingMode: mode,
      }),
      rank,
      score: Number(item.score.toFixed(6)),
      source,
      reasons: [reasonBySource[source] ?? "Một lựa chọn đáng để bạn khám phá"],
    };
  }
}
