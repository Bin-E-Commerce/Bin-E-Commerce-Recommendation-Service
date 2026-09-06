// Service này cập nhật catalog read model, cung cấp candidate queries và bootstrap từ Product API một lần; serving không gọi Product API.

import { Injectable, Logger, OnModuleInit, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type {
  CatalogBootstrapItem,
  CatalogProductListOptions,
  RecommendationCatalogProduct,
} from "../types/catalog-product.type";
import type { RecommendationCatalogEvent } from "@common/kafka/events/recommendation.events";
import { RecommendationRedisService } from "../../../../infrastructure/redis/redis.module";
import { CatalogProductRepository } from "../../infrastructure/repositories/catalog-product.repository";

@Injectable()
export class CatalogService implements OnModuleInit {
  private readonly logger = new Logger(CatalogService.name);

  constructor(
    private readonly repository: CatalogProductRepository,
    private readonly config: ConfigService,
    private readonly redis: RecommendationRedisService,
  ) {}

  // Chạy initial sync tùy chọn sau khi service khởi động; lỗi bootstrap không được làm process recommendation crash.
  async onModuleInit(): Promise<void> {
    if (this.config.get<string>("CATALOG_BOOTSTRAP", "false") !== "true") return;
    const token = this.config.get<string>("INTERNAL_SERVICE_TOKEN");
    await this.bootstrapFromProductService(token).catch((error) => {
      this.logger.warn(`Catalog bootstrap deferred: ${error instanceof Error ? error.message : "unknown error"}`);
    });
  }

  // Upsert snapshot catalog theo version để event cũ không ghi đè dữ liệu mới và delete chỉ chuyển trạng thái.
  async upsert(product: Partial<RecommendationCatalogProduct> & { productId: string }): Promise<void> {
    await this.repository.upsertIfNewer(product);
    await this.redis.invalidateRecommendations();
  }

  // Đánh dấu product không còn public thay vì xóa read model để event cũ và audit vẫn có thể đối chiếu.
  async deactivate(productId: string): Promise<void> {
    await this.repository.deactivate(productId);
    await this.redis.invalidateRecommendations();
  }

  // Nhận catalog event sau commit Product và cập nhật read model; event không hợp lệ sẽ được ném để consumer retry.
  async processEvent(event: RecommendationCatalogEvent): Promise<void> {
    const data = event.data;
    if (!data?.productId || !data.name || !data.slug) throw new Error("Invalid catalog event payload");
    if (event.eventName === "product.catalog.deleted" || data.status === "DELETED") {
      await this.deactivate(data.productId);
      return;
    }
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
      catalogVersion: data.catalogVersion,
    });
  }

  // Lấy sản phẩm active có tồn kho để candidate generator dùng chung cho mọi source.
  async findAvailable(options: CatalogProductListOptions = {}): Promise<RecommendationCatalogProduct[]> {
    return this.repository.findAvailable(options);
  }

  // Tạo source mới/trending bằng một query ổn định để fallback không phụ thuộc profile.
  async findNewest(limit: number, excludeProductIds: string[] = []): Promise<RecommendationCatalogProduct[]> {
    return this.repository.findNewest(limit, excludeProductIds);
  }

  // Lấy sản phẩm bán chạy làm baseline quality khi user/session chưa đủ tín hiệu.
  async findBestSelling(limit: number, excludeProductIds: string[] = []): Promise<RecommendationCatalogProduct[]> {
    return this.repository.findBestSelling(limit, excludeProductIds);
  }

  // Lấy trending từ aggregate hành vi gần đây, không dùng tổng view tuyệt đối để tránh sản phẩm quá cũ luôn đứng đầu.
  async findTrending(limit: number, excludeProductIds: string[] = []): Promise<RecommendationCatalogProduct[]> {
    return this.repository.findTrending(limit, excludeProductIds);
  }

  // Tạo source explore ổn định để cold-start vẫn có độ đa dạng mà không làm kết quả nhảy ngẫu nhiên mỗi request.
  async findExplore(limit: number, excludeProductIds: string[] = []): Promise<RecommendationCatalogProduct[]> {
    return this.repository.findExplore(limit, excludeProductIds);
  }

  // Lấy product theo danh sách affinity và giữ thứ tự score ở lớp application.
  async findByIds(productIds: string[]): Promise<RecommendationCatalogProduct[]> {
    return this.repository.findByIds(productIds);
  }

  // Bootstrap catalog theo page từ Product Service, dùng riêng cho initial sync và không chạy trong recommendation request.
  async bootstrapFromProductService(internalToken: string | undefined): Promise<{ imported: number; pages: number }> {
    const expectedToken = this.config.get<string>("INTERNAL_SERVICE_TOKEN", "");
    if (!expectedToken || internalToken !== expectedToken) throw new UnauthorizedException("Invalid catalog bootstrap token");
    const baseUrl = this.config.get<string>("PRODUCT_SERVICE_URL", "http://localhost:3008").replace(/\/$/, "");
    const pageSize = 100;
    let page = 1;
    let imported = 0;
    const timeoutMs = this.config.get<number>("CATALOG_BOOTSTRAP_TIMEOUT_MS", 10000);
    while (true) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetch(
          `${baseUrl}/api/v1/products?page=${page}&pageSize=${pageSize}&status=ACTIVE&inStock=true`,
          { signal: controller.signal },
        );
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) throw new Error(`Product catalog bootstrap failed with status ${response.status}`);
      const body = (await response.json()) as { items?: CatalogBootstrapItem[]; totalPages?: number };
      const items = body.items ?? [];
      for (const item of items) {
        await this.upsert(this.toReadModel(item));
        imported += 1;
      }
      if (items.length === 0 || page >= (body.totalPages ?? page)) break;
      page += 1;
    }
    this.logger.log(`Catalog bootstrap imported ${imported} products in ${page} pages`);
    return { imported, pages: page };
  }

  // Chuẩn hóa public Product response thành snapshot độc lập để Recommendation không kéo Product entity vào domain.
  private toReadModel(item: CatalogBootstrapItem): RecommendationCatalogProduct {
    const image = [...(item.images ?? [])].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))[0]?.imageUrl ?? null;
    const now = new Date();
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
      minPrice: item.minPrice,
      maxPrice: item.maxPrice,
      ratingAvg: item.ratingAvg ?? null,
      reviewCount: item.reviewCount ?? 0,
      totalSold: item.totalSold ?? 0,
      status: "ACTIVE",
      isInStock: true,
      createdAt: now,
      updatedAt: now,
      catalogVersion: 1,
    };
  }

}
