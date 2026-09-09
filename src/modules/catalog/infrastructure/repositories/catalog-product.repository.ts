// Repository này sở hữu toàn bộ truy vấn catalog read model; CatalogService chỉ điều phối đồng bộ và policy nghiệp vụ.

import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository } from "typeorm";
import { RecommendationCatalogProductEntity } from "../../../../database/catalog/entities/catalog-product.entity";
import type {
  CatalogProductListOptions,
  RecommendationCatalogProduct,
} from "../../application/types/catalog-product.type";

// Adapter persistence cho catalog read model, không gọi Product Service và không chứa candidate/ranking policy.
@Injectable()
export class CatalogProductRepository {
  constructor(
    @InjectRepository(RecommendationCatalogProductEntity)
    private readonly repository: Repository<RecommendationCatalogProductEntity>,
  ) {}

  // Upsert snapshot theo catalog version để event cũ không ghi đè dữ liệu mới hơn.
  async upsertIfNewer(
    product: Partial<RecommendationCatalogProduct> & { productId: string },
  ): Promise<boolean> {
    const current = await this.repository.findOne({ where: { productId: product.productId } });
    const snapshot = {
      ...current,
      ...product,
      catalogVersion: product.catalogVersion ?? current?.catalogVersion ?? "1",
      semanticAttributes: product.semanticAttributes ?? current?.semanticAttributes ?? [],
    };
    const rows = await this.repository.query(
      `INSERT INTO recommendation_catalog_products
        (product_id, origin_type, name, slug, image_url, category_id, brand_id, seller_shop_id, external_shop_id,
         min_price, max_price, rating_avg, review_count, total_sold, status, is_in_stock, created_at, updated_at,
         catalog_version, short_description, description, brand_name, category_path, semantic_attributes, content_hash,
         embedding_status, embedding_model_version, embedding_dimensions)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28)
       ON CONFLICT (product_id) DO UPDATE SET
         origin_type = EXCLUDED.origin_type, name = EXCLUDED.name, slug = EXCLUDED.slug, image_url = EXCLUDED.image_url,
         category_id = EXCLUDED.category_id, brand_id = EXCLUDED.brand_id, seller_shop_id = EXCLUDED.seller_shop_id,
         external_shop_id = EXCLUDED.external_shop_id, min_price = EXCLUDED.min_price, max_price = EXCLUDED.max_price,
         rating_avg = EXCLUDED.rating_avg, review_count = EXCLUDED.review_count, total_sold = EXCLUDED.total_sold,
         status = EXCLUDED.status, is_in_stock = EXCLUDED.is_in_stock, created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at, catalog_version = EXCLUDED.catalog_version,
         short_description = EXCLUDED.short_description, description = EXCLUDED.description,
         brand_name = EXCLUDED.brand_name, category_path = EXCLUDED.category_path,
         semantic_attributes = EXCLUDED.semantic_attributes, content_hash = EXCLUDED.content_hash,
         embedding_status = EXCLUDED.embedding_status, embedding_model_version = EXCLUDED.embedding_model_version,
         embedding_dimensions = EXCLUDED.embedding_dimensions
       WHERE recommendation_catalog_products.catalog_version <= EXCLUDED.catalog_version
       RETURNING product_id`,
      [
        snapshot.productId, snapshot.originType, snapshot.name, snapshot.slug, snapshot.imageUrl ?? null,
        snapshot.categoryId ?? null, snapshot.brandId ?? null, snapshot.sellerShopId ?? null, snapshot.externalShopId ?? null,
        snapshot.minPrice ?? "0", snapshot.maxPrice ?? snapshot.minPrice ?? "0", snapshot.ratingAvg ?? null,
        snapshot.reviewCount ?? 0, snapshot.totalSold ?? 0, snapshot.status ?? "INACTIVE", snapshot.isInStock ?? false,
        snapshot.createdAt ?? new Date(), snapshot.updatedAt ?? new Date(), snapshot.catalogVersion,
        snapshot.shortDescription ?? null, snapshot.description ?? null, snapshot.brandName ?? null,
        snapshot.categoryPath ?? null, JSON.stringify(snapshot.semanticAttributes), snapshot.contentHash ?? null,
        snapshot.embeddingStatus ?? "NOT_REQUIRED", snapshot.embeddingModelVersion ?? null, snapshot.embeddingDimensions ?? null,
      ],
    ) as Array<{ product_id: string }>;
    return rows.length > 0;
  }

  // Cập nhật metadata embedding atomically mà không thay đổi snapshot catalog động.
  async updateEmbeddingState(
    productId: string,
    input: { status: RecommendationCatalogProductEntity["embeddingStatus"]; modelVersion?: string | null; dimensions?: number | null },
  ): Promise<void> {
    await this.repository.update(
      { productId },
      {
        embeddingStatus: input.status,
        embeddingModelVersion: input.modelVersion,
        embeddingDimensions: input.dimensions,
      },
    );
  }

  // Đọc snapshot hiện tại để completion consumer kiểm tra contentHash/model trước khi ghi vector.
  async findOne(productId: string): Promise<RecommendationCatalogProductEntity | null> {
    return this.repository.findOne({ where: { productId } });
  }

  // Chuyển product thành inactive và hết hàng nhưng vẫn giữ read model để audit/event cũ còn đối chiếu được.
  async deactivate(productId: string, catalogVersion?: string): Promise<boolean> {
    const rows = await this.repository.query(
      `UPDATE recommendation_catalog_products
          SET status = 'INACTIVE', is_in_stock = false,
              catalog_version = COALESCE($2, catalog_version), updated_at = now()
        WHERE product_id = $1
          AND ($2 IS NULL OR catalog_version <= $2)
        RETURNING product_id`,
      [productId, catalogVersion ?? null],
    ) as Array<{ product_id: string }>;
    return rows.length > 0;
  }

  // Lấy candidate active/còn hàng theo category hoặc brand affinity với giới hạn an toàn.
  async findAvailable(
    options: CatalogProductListOptions = {},
  ): Promise<RecommendationCatalogProductEntity[]> {
    const query = this.repository
      .createQueryBuilder("product")
      .where("product.status = :status", { status: "ACTIVE" })
      .andWhere("product.isInStock = :inStock", { inStock: true });

    if (options.categoryIds?.length) {
      query.andWhere("product.category_id IN (:...categoryIds)", {
        categoryIds: options.categoryIds,
      });
    }
    if (options.brandIds?.length) {
      query.andWhere("product.brand_id IN (:...brandIds)", {
        brandIds: options.brandIds,
      });
    }
    if (options.excludeProductIds?.length) {
      query.andWhere("product.product_id NOT IN (:...excludeProductIds)", {
        excludeProductIds: options.excludeProductIds,
      });
    }

    return query
      .orderBy("product.total_sold", "DESC")
      .limit(Math.min(options.limit ?? 50, 200))
      .getMany();
  }

  // Lấy source sản phẩm mới theo created_at, có exclusion và tie-breaker ổn định.
  async findNewest(
    limit: number,
    excludeProductIds: string[] = [],
  ): Promise<RecommendationCatalogProductEntity[]> {
    return this.findOrdered("product.created_at", "DESC", limit, excludeProductIds);
  }

  // Lấy source best-selling từ total_sold để làm baseline cho user mới hoặc guest.
  async findBestSelling(
    limit: number,
    excludeProductIds: string[] = [],
  ): Promise<RecommendationCatalogProductEntity[]> {
    return this.findOrdered("product.total_sold", "DESC", limit, excludeProductIds);
  }

  // Join popularity aggregate để lấy trending mà không đẩy query popularity vào application service.
  async findTrending(
    limit: number,
    excludeProductIds: string[] = [],
  ): Promise<RecommendationCatalogProductEntity[]> {
    const query = this.repository
      .createQueryBuilder("product")
      .leftJoin(
        `(SELECT product_id,
                 SUM(CASE WHEN bucket_date >= CURRENT_DATE THEN views ELSE 0 END) AS views_1d,
                 SUM(CASE WHEN bucket_date >= CURRENT_DATE - INTERVAL '6 days' THEN views ELSE 0 END) AS views_7d,
                 SUM(CASE WHEN bucket_date >= CURRENT_DATE THEN clicks ELSE 0 END) AS clicks_1d,
                 SUM(CASE WHEN bucket_date >= CURRENT_DATE - INTERVAL '6 days' THEN cart_adds ELSE 0 END) AS cart_adds_7d,
                 SUM(CASE WHEN bucket_date >= CURRENT_DATE - INTERVAL '29 days' THEN purchases ELSE 0 END) AS purchases_30d,
                 SUM(CASE WHEN bucket_date >= CURRENT_DATE THEN views ELSE 0 END) * 0.1
                   + SUM(CASE WHEN bucket_date >= CURRENT_DATE THEN clicks ELSE 0 END) * 0.5
                   + SUM(CASE WHEN bucket_date >= CURRENT_DATE - INTERVAL '6 days' THEN cart_adds ELSE 0 END) * 2
                   + SUM(CASE WHEN bucket_date >= CURRENT_DATE - INTERVAL '29 days' THEN purchases ELSE 0 END) * 3 AS rolling_score
          FROM recommendation_product_popularity_daily
         WHERE bucket_date >= CURRENT_DATE - INTERVAL '29 days'
         GROUP BY product_id)`,
        "popularity",
        "popularity.product_id = product.product_id",
      )
      .leftJoin(
        "recommendation_product_popularity",
        "legacy_popularity",
        "legacy_popularity.product_id = product.product_id",
      )
      .where("product.status = :status", { status: "ACTIVE" })
      .andWhere("product.is_in_stock = :inStock", { inStock: true });

    if (excludeProductIds.length) {
      query.andWhere("product.product_id NOT IN (:...excludeProductIds)", {
        excludeProductIds,
      });
    }

    return query
      .orderBy("COALESCE(popularity.rolling_score, legacy_popularity.popularity_score, 0)", "DESC")
      .addOrderBy("product.total_sold", "DESC")
      .addOrderBy("product.product_id", "ASC")
      .limit(Math.min(limit, 200))
      .getMany();
  }

  // Lấy source explore có thứ tự ổn định để cold-start không thay đổi ngẫu nhiên giữa các request.
  async findExplore(
    limit: number,
    excludeProductIds: string[] = [],
  ): Promise<RecommendationCatalogProductEntity[]> {
    return this.findOrdered("product.product_id", "ASC", limit, excludeProductIds);
  }

  // Lấy product theo affinity IDs và chỉ trả sản phẩm còn đủ điều kiện public/stock.
  async findByIds(productIds: string[]): Promise<RecommendationCatalogProductEntity[]> {
    if (productIds.length === 0) return [];
    return this.repository.find({
      where: { productId: In(productIds), status: "ACTIVE", isInStock: true },
    });
  }

  // Dùng chung query ordered để mọi source áp dụng cùng active/stock/exclusion policy.
  private async findOrdered(
    column: string,
    direction: "ASC" | "DESC",
    limit: number,
    excludeProductIds: string[],
  ): Promise<RecommendationCatalogProductEntity[]> {
    const query = this.repository
      .createQueryBuilder("product")
      .where("product.status = :status", { status: "ACTIVE" })
      .andWhere("product.is_in_stock = :inStock", { inStock: true });

    if (excludeProductIds.length) {
      query.andWhere("product.product_id NOT IN (:...excludeProductIds)", {
        excludeProductIds,
      });
    }

    return query
      .orderBy(column, direction)
      .addOrderBy("product.product_id", "ASC")
      .limit(Math.min(limit, 200))
      .getMany();
  }
}
