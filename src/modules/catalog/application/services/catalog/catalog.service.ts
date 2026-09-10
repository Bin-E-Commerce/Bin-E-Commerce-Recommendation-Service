// Service này cập nhật catalog read model, cung cấp candidate queries và bootstrap từ Product API một lần; serving không gọi Product API.

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type {
  CatalogBootstrapItem,
  CatalogProductListOptions,
  RecommendationCatalogProduct,
} from "../../types/catalog-product.type";
import type { RecommendationCatalogEvent } from "@common/kafka/events/recommendation.events";
import { RecommendationRedisService } from "../../../../../infrastructure/redis/redis.module";
import { CatalogProductRepository } from "../../../infrastructure/repositories/catalog-product.repository";
import { EmbeddingJobService } from "../embedding/embedding-job.service";
import { SemanticContentService } from "../semantic/semantic-content.service";
import { VectorIndexService } from "../vector/vector-index.service";
import { CatalogSyncCheckpointRepository } from "../../../infrastructure/repositories/catalog-sync-checkpoint.repository";
import { DataSource, EntityManager } from "typeorm";

@Injectable()
export class CatalogService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CatalogService.name);
  private bootstrapTimer?: NodeJS.Timeout;
  private bootstrapPromise?: Promise<{ imported: number; pages: number }>;
  private stopping = false;

  constructor(
    private readonly repository: CatalogProductRepository,
    private readonly config: ConfigService,
    private readonly redis: RecommendationRedisService,
    private readonly embeddingJobs: EmbeddingJobService,
    private readonly semantic: SemanticContentService,
    private readonly vector: VectorIndexService,
    private readonly checkpoints: CatalogSyncCheckpointRepository,
    private readonly dataSource: DataSource,
  ) {}

  // Chạy initial sync tùy chọn sau khi service khởi động; lỗi bootstrap không được làm process recommendation crash.
  async onModuleInit(): Promise<void> {
    this.stopping = false;
    if (this.config.get<string>("CATALOG_BOOTSTRAP", "false") !== "true")
      return;
    const token = this.config.get<string>("INTERNAL_SERVICE_TOKEN");
    void this.bootstrapWithRetry(token);
  }

  // Dừng lịch retry khi shutdown để bootstrap không tiếp tục gọi Product Service sau khi Nest đã đóng.
  onModuleDestroy(): void {
    this.stopping = true;
    if (this.bootstrapTimer) clearTimeout(this.bootstrapTimer);
  }

  // Retry bootstrap khi Product Service/Kafka khởi động chậm nhưng không tạo nhiều bootstrap chạy song song.
  private async bootstrapWithRetry(token: string | undefined): Promise<void> {
    try {
      await this.bootstrapFromProductService(token);
    } catch (error) {
      this.logger.warn(
        `Catalog bootstrap deferred: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      if (!this.stopping) {
        const retryMs = Number(
          this.config.get<string>("CATALOG_BOOTSTRAP_RETRY_MS", "30000"),
        );
        this.bootstrapTimer = setTimeout(
          () => {
            this.bootstrapTimer = undefined;
            void this.bootstrapWithRetry(token);
          },
          Number.isFinite(retryMs) ? Math.max(5000, retryMs) : 30000,
        );
      }
    }
  }

  // Upsert snapshot catalog theo version để event cũ không ghi đè dữ liệu mới và delete chỉ chuyển trạng thái.
  async upsert(
    product: Partial<RecommendationCatalogProduct> & { productId: string },
  ): Promise<void> {
    const transactionResult = await this.upsertAndQueueEmbedding(product);
    const applied = transactionResult.applied;
    const current = transactionResult.current;
    // Event redelivery cÃ³ thá»ƒ tháº¥y snapshot Ä‘Ã£ ghi nhÆ°ng job chÆ°a commit; kiá»ƒm tra durable state Ä‘á»ƒ khÃ´i phá»¥c job thay vÃ¬ bá» qua theo `applied`.
    if (!current || current.contentHash !== product.contentHash) return;
    const contentHash = product.contentHash;
    const title = product.name;
    const attributes = product.semanticAttributes;
    const shouldEnsureEmbedding = Boolean(
      contentHash && attributes && title && current.embeddingStatus !== "READY",
    );
    if (shouldEnsureEmbedding && !transactionResult.embeddingQueued) {
      await this.embeddingJobs.enqueueProduct({
        productId: product.productId,
        contentHash: contentHash as string,
        textContent: this.semantic.toEmbeddingText({
          title: title as string,
          shortDescription: product.shortDescription ?? null,
          description: product.description ?? null,
          brandName: product.brandName ?? null,
          categoryPath: product.categoryPath ?? null,
          attributes: attributes as Array<{ key: string; value: string }>,
          contentHash: contentHash as string,
        }),
      });
    }
    if (applied && product.status && product.contentHash) {
      await this.vectorPayloadUpdate(product.productId, {
        status: product.status,
        isInStock: product.isInStock,
      });
    }
    if (applied) await this.redis.invalidateRecommendations();
  }

  // Commit catalog snapshot và embedding outbox cùng transaction để process crash không làm mất job semantic.
  private async upsertAndQueueEmbedding(
    product: Partial<RecommendationCatalogProduct> & { productId: string },
  ): Promise<{
    applied: boolean;
    current: RecommendationCatalogProduct | null;
    embeddingQueued: boolean;
  }> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const applied = await this.repository.upsertIfNewer(product, manager);
      const current = await this.repository.findOneWithManager(
        product.productId,
        manager,
      );
      const expectedModel = this.config.get<string>(
        "EMBEDDING_MODEL_VERSION",
        this.config.get<string>("EMBEDDING_MODEL", "text-embedding-3-small"),
      );
      const configuredDimensions = Number(
        this.config.get<string>("QDRANT_VECTOR_SIZE", "1536"),
      );
      const expectedDimensions =
        Number.isInteger(configuredDimensions) && configuredDimensions > 0
          ? configuredDimensions
          : 1536;
      if (
        !current ||
        current.contentHash !== product.contentHash ||
        !product.contentHash ||
        !product.name ||
        !product.semanticAttributes
      ) {
        return { applied, current, embeddingQueued: false };
      }
      const embeddingIsCurrent =
        current.embeddingStatus === "READY" &&
        current.embeddingModelVersion === expectedModel &&
        current.embeddingDimensions === expectedDimensions;
      if (embeddingIsCurrent) {
        return { applied, current, embeddingQueued: false };
      }
      await this.embeddingJobs.enqueueProduct(
        {
          productId: product.productId,
          contentHash: product.contentHash,
          textContent: this.semantic.toEmbeddingText({
            title: product.name,
            shortDescription: product.shortDescription ?? null,
            description: product.description ?? null,
            brandName: product.brandName ?? null,
            categoryPath: product.categoryPath ?? null,
            attributes: product.semanticAttributes,
            contentHash: product.contentHash,
          }),
        },
        manager,
      );
      return { applied, current, embeddingQueued: true };
    });
  }

  // Đánh dấu product không còn public thay vì xóa read model để event cũ và audit vẫn có thể đối chiếu.
  async deactivate(productId: string): Promise<void> {
    const applied = await this.repository.deactivate(productId);
    if (!applied) return;
    await this.vectorPayloadUpdate(productId, {
      status: "INACTIVE",
      isInStock: false,
    });
    await this.redis.invalidateRecommendations();
  }

  // Nhận catalog event sau commit Product và cập nhật read model; event không hợp lệ sẽ được ném để consumer retry.
  async processEvent(event: RecommendationCatalogEvent): Promise<void> {
    const data = event.data;
    const isDeletedEvent =
      event.eventName === "product.catalog.deleted" ||
      data.status === "DELETED";
    if (!data?.productId || (!isDeletedEvent && (!data.name || !data.slug)))
      throw new Error("Invalid catalog event payload");
    if (isDeletedEvent) {
      const applied = await this.repository.deactivate(
        data.productId,
        data.catalogRevision,
      );
      if (applied) {
        await this.vectorPayloadUpdate(data.productId, {
          status: "INACTIVE",
          isInStock: false,
        });
        await this.redis.invalidateRecommendations();
      }
      return;
    }
    const current = await this.repository.findOne(data.productId);
    await this.upsert({
      productId: data.productId,
      originType: data.originType,
      name: data.name,
      slug: data.slug,
      imageUrl: data.imageUrl,
      categoryId: data.categoryId,
      brandId: data.brandId,
      sellerShopId: data.sellerShopId,
      externalShopId: data.externalShopId,
      minPrice: data.minPrice,
      maxPrice: data.maxPrice,
      ratingAvg: data.ratingAvg,
      reviewCount: data.reviewCount,
      totalSold: data.totalSold,
      status: data.status,
      isInStock: data.isInStock,
      createdAt: new Date(data.createdAt),
      updatedAt: new Date(data.updatedAt),
      catalogVersion: data.catalogRevision,
      shortDescription: data.semanticContent.shortDescription,
      description: data.semanticContent.description,
      brandName: data.semanticContent.brandName,
      categoryPath: data.semanticContent.categoryPath,
      semanticAttributes: data.semanticContent.attributes,
      contentHash: data.semanticContent.contentHash,
      embeddingStatus:
        current?.contentHash === data.semanticContent.contentHash
          ? current.embeddingStatus
          : "PENDING",
    });
  }

  // Cập nhật payload Qdrant best-effort cho status/stock; vector index unavailable không được làm catalog event retry vô hạn.
  private async vectorPayloadUpdate(
    productId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.vector.updateProductPayload(productId, payload);
    } catch (error) {
      this.logger.debug(
        `Qdrant payload update deferred for ${productId}: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  }

  // Lấy sản phẩm active có tồn kho để candidate generator dùng chung cho mọi source.
  async findAvailable(
    options: CatalogProductListOptions = {},
  ): Promise<RecommendationCatalogProduct[]> {
    return this.repository.findAvailable(options);
  }

  // Tạo source mới/trending bằng một query ổn định để fallback không phụ thuộc profile.
  async findNewest(
    limit: number,
    excludeProductIds: string[] = [],
  ): Promise<RecommendationCatalogProduct[]> {
    return this.repository.findNewest(limit, excludeProductIds);
  }

  // Lấy sản phẩm bán chạy làm baseline quality khi user/session chưa đủ tín hiệu.
  async findBestSelling(
    limit: number,
    excludeProductIds: string[] = [],
  ): Promise<RecommendationCatalogProduct[]> {
    return this.repository.findBestSelling(limit, excludeProductIds);
  }

  // Lấy trending từ aggregate hành vi gần đây, không dùng tổng view tuyệt đối để tránh sản phẩm quá cũ luôn đứng đầu.
  async findTrending(
    limit: number,
    excludeProductIds: string[] = [],
  ): Promise<RecommendationCatalogProduct[]> {
    return this.repository.findTrending(limit, excludeProductIds);
  }

  // Tạo source explore ổn định để cold-start vẫn có độ đa dạng mà không làm kết quả nhảy ngẫu nhiên mỗi request.
  async findExplore(
    limit: number,
    excludeProductIds: string[] = [],
  ): Promise<RecommendationCatalogProduct[]> {
    return this.repository.findExplore(limit, excludeProductIds);
  }

  // Lấy product theo danh sách affinity và giữ thứ tự score ở lớp application.
  async findByIds(
    productIds: string[],
  ): Promise<RecommendationCatalogProduct[]> {
    return this.repository.findByIds(productIds);
  }

  // Bootstrap catalog theo page từ Product Service, dùng riêng cho initial sync và không chạy trong recommendation request.
  async bootstrapFromProductService(
    internalToken: string | undefined,
  ): Promise<{ imported: number; pages: number }> {
    if (this.bootstrapPromise) return this.bootstrapPromise;
    this.bootstrapPromise = this.runBootstrapFromProductService(internalToken);
    try {
      return await this.bootstrapPromise;
    } finally {
      this.bootstrapPromise = undefined;
    }
  }

  // Thực hiện snapshot pagination; wrapper phía trên chịu trách nhiệm chống chạy chồng giữa endpoint và worker nền.
  private async runBootstrapFromProductService(
    internalToken: string | undefined,
  ): Promise<{ imported: number; pages: number }> {
    const expectedToken = this.config.get<string>("INTERNAL_SERVICE_TOKEN", "");
    if (!expectedToken || internalToken !== expectedToken)
      throw new UnauthorizedException("Invalid catalog bootstrap token");
    const baseUrl = this.config
      .get<string>("PRODUCT_SERVICE_URL", "http://localhost:3008")
      .replace(/\/$/, "");
    const pageSize = 100;
    let page =
      this.config.get<string>("CATALOG_BOOTSTRAP_RESET", "false") === "true"
        ? 1
        : await this.checkpoints.getNextPage("product-catalog");
    let imported = 0;
    const configuredTimeoutMs = Number(
      this.config.get<string>("CATALOG_BOOTSTRAP_TIMEOUT_MS", "10000"),
    );
    const timeoutMs = Number.isFinite(configuredTimeoutMs)
      ? Math.min(Math.max(Math.trunc(configuredTimeoutMs), 1000), 120_000)
      : 10_000;
    while (true) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetch(
          `${baseUrl}/api/v1/internal/products/catalog-snapshot?page=${page}&pageSize=${pageSize}`,
          {
            signal: controller.signal,
            headers: { "x-internal-service-token": internalToken ?? "" },
          },
        );
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok)
        throw new Error(
          `Product catalog bootstrap failed with status ${response.status}`,
        );
      const body = (await response.json()) as {
        items?: CatalogBootstrapItem[];
        totalPages?: number;
      };
      const items = body.items ?? [];
      for (const item of items) {
        await this.upsert(this.toReadModel(item));
        imported += 1;
      }
      await this.checkpoints.saveNextPage("product-catalog", page + 1);
      if (items.length === 0 || page >= (body.totalPages ?? page)) break;
      page += 1;
    }
    this.logger.log(
      `Catalog bootstrap imported ${imported} products in ${page} pages`,
    );
    return { imported, pages: page };
  }

  // Chuẩn hóa public Product response thành snapshot độc lập để Recommendation không kéo Product entity vào domain.
  private toReadModel(
    item: CatalogBootstrapItem,
  ): RecommendationCatalogProduct {
    const image =
      item.imageUrl ??
      [...(item.images ?? [])].sort(
        (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0),
      )[0]?.imageUrl ??
      null;
    const now = new Date();
    const semanticContent = this.semantic.withHash({
      title: item.name,
      shortDescription: item.shortDescription ?? null,
      description: item.description ?? null,
      brandName: item.brandName ?? null,
      categoryPath: item.categoryPath ?? null,
      attributes: item.semanticAttributes ?? [],
      contentHash: "",
    });
    return {
      productId: item.id,
      originType: item.originType ?? "EXTERNAL",
      name: item.name,
      slug: item.slug,
      imageUrl: image,
      categoryId: item.categoryId ?? null,
      brandId: item.brand?.id ?? null,
      sellerShopId: item.sellerShopId ?? null,
      externalShopId: item.externalShop?.id ?? null,
      minPrice: item.minPrice ?? "0",
      maxPrice: item.maxPrice ?? item.minPrice ?? "0",
      ratingAvg: item.ratingAvg ?? null,
      reviewCount: item.reviewCount ?? 0,
      totalSold: item.totalSold ?? 0,
      status: item.status ?? "ACTIVE",
      isInStock: item.isInStock ?? true,
      createdAt: item.createdAt ? new Date(item.createdAt) : now,
      updatedAt: item.updatedAt ? new Date(item.updatedAt) : now,
      catalogVersion: item.catalogVersion ?? "1",
      shortDescription: item.shortDescription ?? null,
      description: item.description ?? null,
      brandName: item.brandName ?? null,
      categoryPath: item.categoryPath ?? null,
      semanticAttributes: item.semanticAttributes ?? [],
      contentHash: item.contentHash ?? semanticContent.contentHash,
      embeddingStatus:
        item.contentHash || semanticContent.contentHash
          ? "PENDING"
          : "NOT_REQUIRED",
      embeddingModelVersion: null,
      embeddingDimensions: null,
    };
  }
}
