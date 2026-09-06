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
  ): Promise<void> {
    const current = await this.repository.findOne({
      where: { productId: product.productId },
    });
    if (current && (current.catalogVersion ?? 0) > (product.catalogVersion ?? 0)) return;

    await this.repository.save(
      this.repository.create({
        ...(current ?? {}),
        ...product,
        catalogVersion: product.catalogVersion ?? current?.catalogVersion ?? 1,
      }),
    );
  }

  // Chuyển product thành inactive và hết hàng nhưng vẫn giữ read model để audit/event cũ còn đối chiếu được.
  async deactivate(productId: string): Promise<void> {
    await this.repository.update(
      { productId },
      { status: "INACTIVE", isInStock: false },
    );
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
