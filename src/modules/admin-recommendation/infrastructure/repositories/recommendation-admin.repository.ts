// Repository này sở hữu toàn bộ query read-side của Admin Recommendation; service không viết SQL trực tiếp.

import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import { RecommendationInteractionEntity } from "../../../../database/interactions/entities/interaction.entity";
import { RecommendationPolicyEntity } from "../../../../database/policies/entities/policy.entity";
import { CatalogProductRepository } from "../../../catalog/infrastructure/repositories/catalog-product.repository";

interface AggregateRow {
  events: string;
  productViews: string;
  impressions: string;
  clicks: string;
  searches: string;
  cartAdds: string;
  cartRemovals: string;
  uniqueActors: string;
}

interface CountRow {
  count: string;
}

interface PurchaseDailyRow {
  day: Date | string;
  purchaseCompleted: string;
  purchaseReturned: string;
}

// Chuẩn hóa ngày lịch từ PostgreSQL (có thể trả Date hoặc string) thành một key duy nhất để ghép timeline.
function toCalendarDateKey(value: Date | string): string {
  if (value instanceof Date) {
    // PostgreSQL date được node-postgres parse thành local midnight; lấy component local để không lùi một ngày theo UTC.
    return [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, "0"),
      String(value.getDate()).padStart(2, "0"),
    ].join("-");
  }
  return value.slice(0, 10);
}

@Injectable()
export class RecommendationAdminRepository {
  constructor(
    @InjectRepository(RecommendationInteractionEntity)
    private readonly interactions: Repository<RecommendationInteractionEntity>,
    @InjectRepository(RecommendationPolicyEntity)
    private readonly policies: Repository<RecommendationPolicyEntity>,
    private readonly catalogProducts: CatalogProductRepository,
    private readonly dataSource: DataSource,
  ) {}

  // Aggregate KPI từ interaction attribution; chỉ tính event gắn recommendation request để số liệu không lẫn listing thường.
  async getOverview(from: Date, to: Date) {
    const base = this.interactions
      .createQueryBuilder("interaction")
      .where("interaction.occurred_at >= :from", { from })
      .andWhere("interaction.occurred_at < :to", { to })
      .andWhere("interaction.recommendation_request_id IS NOT NULL");
    // Activity timeline không lọc attribution để các event view/remove trực tiếp vẫn xuất hiện trong Admin.
    // Các KPI đánh giá recommendation bên trên vẫn dùng base có attribution để không làm sai CTR và A/B.
    const activityBase = this.interactions
      .createQueryBuilder("interaction")
      .where("interaction.occurred_at >= :from", { from })
      .andWhere("interaction.occurred_at < :to", { to });
    // Tách tổng cart add khỏi base recommendation-attributed để dashboard không báo 0
    // khi user thêm trực tiếp từ product detail; CTR và A/B vẫn chỉ dùng event có attribution.
    const [
      aggregate,
      totalCartAdds,
      activityAggregate,
      daily,
      purchaseDaily,
      topProducts,
    ] = await Promise.all([
      base
        .clone()
        .select("COUNT(*)", "events")
        .addSelect(
          "COUNT(*) FILTER (WHERE interaction.interaction_type = 'PRODUCT_VIEWED')",
          "productViews",
        )
        .addSelect(
          "COUNT(*) FILTER (WHERE interaction.interaction_type = 'PRODUCT_IMPRESSED')",
          "impressions",
        )
        .addSelect(
          "COUNT(*) FILTER (WHERE interaction.interaction_type = 'PRODUCT_CLICKED')",
          "clicks",
        )
        .addSelect(
          "COUNT(*) FILTER (WHERE interaction.interaction_type = 'SEARCH_PERFORMED')",
          "searches",
        )
        .addSelect(
          "COUNT(*) FILTER (WHERE interaction.interaction_type = 'PRODUCT_ADDED_TO_CART')",
          "cartAdds",
        )
        .addSelect(
          "COUNT(*) FILTER (WHERE interaction.interaction_type = 'PRODUCT_REMOVED_FROM_CART')",
          "cartRemovals",
        )
        .addSelect(
          "COUNT(DISTINCT COALESCE(interaction.user_id, interaction.session_id))",
          "uniqueActors",
        )
        .getRawOne<AggregateRow>(),
      this.interactions
        .createQueryBuilder("cartInteraction")
        .select("COUNT(*)", "count")
        .where("cartInteraction.occurred_at >= :from", { from })
        .andWhere("cartInteraction.occurred_at < :to", { to })
        .andWhere("cartInteraction.interaction_type = 'PRODUCT_ADDED_TO_CART'")
        .getRawOne<CountRow>(),
      activityBase
        .clone()
        .select("COUNT(*)", "events")
        .addSelect(
          "COUNT(*) FILTER (WHERE interaction.interaction_type = 'PRODUCT_VIEWED')",
          "productViews",
        )
        .addSelect(
          "COUNT(*) FILTER (WHERE interaction.interaction_type = 'PRODUCT_IMPRESSED')",
          "impressions",
        )
        .addSelect(
          "COUNT(*) FILTER (WHERE interaction.interaction_type = 'PRODUCT_CLICKED')",
          "clicks",
        )
        .addSelect(
          "COUNT(*) FILTER (WHERE interaction.interaction_type = 'SEARCH_PERFORMED')",
          "searches",
        )
        .addSelect(
          "COUNT(*) FILTER (WHERE interaction.interaction_type = 'PRODUCT_ADDED_TO_CART')",
          "cartAdds",
        )
        .addSelect(
          "COUNT(*) FILTER (WHERE interaction.interaction_type = 'PRODUCT_REMOVED_FROM_CART')",
          "cartRemovals",
        )
        .addSelect(
          "COUNT(DISTINCT COALESCE(interaction.user_id, interaction.session_id))",
          "uniqueActors",
        )
        .getRawOne<AggregateRow>(),
      activityBase
        .clone()
        .select("DATE_TRUNC('day', interaction.occurred_at)", "day")
        .addSelect("COUNT(*)", "events")
        .addSelect(
          "COUNT(*) FILTER (WHERE interaction.interaction_type = 'PRODUCT_VIEWED')",
          "productViews",
        )
        .addSelect(
          "COUNT(*) FILTER (WHERE interaction.interaction_type = 'PRODUCT_IMPRESSED')",
          "impressions",
        )
        .addSelect(
          "COUNT(*) FILTER (WHERE interaction.interaction_type = 'PRODUCT_CLICKED')",
          "clicks",
        )
        .addSelect(
          "COUNT(*) FILTER (WHERE interaction.interaction_type = 'SEARCH_PERFORMED')",
          "searches",
        )
        .addSelect(
          "COUNT(*) FILTER (WHERE interaction.interaction_type = 'PRODUCT_ADDED_TO_CART')",
          "cartAdds",
        )
        .addSelect(
          "COUNT(*) FILTER (WHERE interaction.interaction_type = 'PRODUCT_REMOVED_FROM_CART')",
          "cartRemovals",
        )
        .groupBy("DATE_TRUNC('day', interaction.occurred_at)")
        .orderBy("day", "ASC")
        .getRawMany<{
          day: Date;
          events: string;
          productViews: string;
          impressions: string;
          clicks: string;
          searches: string;
          cartAdds: string;
          cartRemovals: string;
        }>(),
      // Purchase event được project vào popularity daily thay vì interaction log; đọc hai counter riêng để không mất return.
      this.dataSource.query<PurchaseDailyRow[]>(
        `SELECT
           bucket_date AS "day",
           COALESCE(SUM(purchase_completed), 0)::text AS "purchaseCompleted",
           COALESCE(SUM(purchase_returned), 0)::text AS "purchaseReturned"
         FROM recommendation_product_popularity_daily
           WHERE bucket_date >= ($1::timestamptz AT TIME ZONE 'UTC')::date
           -- to là mốc thời gian loại trừ; nếu nó nằm giữa ngày thì phải lấy luôn bucket của ngày đó.
           -- Nếu to đúng 00:00 UTC (preset từ frontend), ngày đó vẫn bị loại đúng theo quy ước [from, to).
           AND bucket_date < (
             ($2::timestamptz AT TIME ZONE 'UTC')::date
             + CASE
                 WHEN ($2::timestamptz AT TIME ZONE 'UTC')::time > TIME '00:00:00'
                 THEN 1
                 ELSE 0
               END
           )
         GROUP BY bucket_date
         ORDER BY bucket_date ASC`,
        [from.toISOString(), to.toISOString()],
      ),
      base
        .clone()
        .select("interaction.product_id", "productId")
        .addSelect("COUNT(*)", "events")
        .addSelect(
          "COUNT(*) FILTER (WHERE interaction.interaction_type = 'PRODUCT_CLICKED')",
          "clicks",
        )
        .addSelect(
          "COUNT(*) FILTER (WHERE interaction.interaction_type = 'PRODUCT_ADDED_TO_CART')",
          "cartAdds",
        )
        .andWhere("interaction.product_id IS NOT NULL")
        .groupBy("interaction.product_id")
        .orderBy("events", "DESC")
        // PostgreSQL giữ nguyên alias camelCase vì TypeORM đã quote alias ở SELECT.
        .addOrderBy('"productId"', "ASC")
        .limit(10)
        .getRawMany<{
          productId: string;
          events: string;
          clicks: string;
          cartAdds: string;
        }>(),
    ]);

    const impressions = Number(aggregate?.impressions ?? 0);
    const clicks = Number(aggregate?.clicks ?? 0);
    const purchaseCompleted = purchaseDaily.reduce(
      (total, row) => total + Number(row.purchaseCompleted ?? 0),
      0,
    );
    const purchaseReturned = purchaseDaily.reduce(
      (total, row) => total + Number(row.purchaseReturned ?? 0),
      0,
    );
    const productIds = topProducts.map((row) => row.productId).filter(Boolean);
    // Hydrate catalog trong một lần đọc để Admin có tên/ảnh mà không tạo N+1 query;
    // nếu snapshot chưa đồng bộ, vẫn trả thống kê với productId làm fallback an toàn.
    const catalogSnapshots =
      await this.catalogProducts.findSnapshots(productIds);
    const catalogByProductId = new Map(
      catalogSnapshots.map((product) => [product.productId, product]),
    );
    const dailyByDate = new Map(
      daily.map((row) => [new Date(row.day).toISOString().slice(0, 10), row]),
    );
    const purchaseByDate = new Map(
      purchaseDaily.map((row) => [toCalendarDateKey(row.day), row]),
    );
    const dailyDates = [
      ...new Set([...dailyByDate.keys(), ...purchaseByDate.keys()]),
    ].sort();

    return {
      range: { from: from.toISOString(), to: to.toISOString() },
      totals: {
        events: Number(aggregate?.events ?? 0),
        totalInteractions: Number(activityAggregate?.events ?? 0),
        eventBreakdown: {
          productViews: Number(activityAggregate?.productViews ?? 0),
          impressions: Number(activityAggregate?.impressions ?? 0),
          clicks: Number(activityAggregate?.clicks ?? 0),
          searches: Number(activityAggregate?.searches ?? 0),
          cartAdds: Number(activityAggregate?.cartAdds ?? 0),
          cartRemovals: Number(activityAggregate?.cartRemovals ?? 0),
          purchaseCompleted,
          purchaseReturned,
        },
        impressions,
        clicks,
        cartAdds: Number(aggregate?.cartAdds ?? 0),
        totalCartAdds: Number(totalCartAdds?.count ?? 0),
        uniqueActors: Number(aggregate?.uniqueActors ?? 0),
        clickThroughRate:
          impressions > 0 ? Number((clicks / impressions).toFixed(4)) : 0,
        clickToCartRate:
          clicks > 0
            ? Number((Number(aggregate?.cartAdds ?? 0) / clicks).toFixed(4))
            : 0,
      },
      // Gộp interaction và purchase theo ngày; ngày chỉ có mua hàng vẫn phải xuất hiện trên timeline.
      daily: dailyDates.map((day) => {
        const interaction = dailyByDate.get(day);
        const purchase = purchaseByDate.get(day);
        return {
          day,
          events: Number(interaction?.events ?? 0),
          productViews: Number(interaction?.productViews ?? 0),
          impressions: Number(interaction?.impressions ?? 0),
          clicks: Number(interaction?.clicks ?? 0),
          searches: Number(interaction?.searches ?? 0),
          cartAdds: Number(interaction?.cartAdds ?? 0),
          cartRemovals: Number(interaction?.cartRemovals ?? 0),
          purchaseCompleted: Number(purchase?.purchaseCompleted ?? 0),
          purchaseReturned: Number(purchase?.purchaseReturned ?? 0),
        };
      }),
      topProducts: topProducts.map((row) => ({
        productId: row.productId,
        productName: catalogByProductId.get(row.productId)?.name ?? null,
        imageUrl: catalogByProductId.get(row.productId)?.imageUrl ?? null,
        originType: catalogByProductId.get(row.productId)?.originType ?? null,
        events: Number(row.events),
        clicks: Number(row.clicks),
        cartAdds: Number(row.cartAdds),
      })),
    };
  }

  // Liệt kê actor đã có recommendation activity, chỉ trả ID và thống kê aggregate cần cho màn hình Admin.
  async listActors(
    from: Date,
    to: Date,
    page: number,
    pageSize: number,
    actorType?: "USER" | "SESSION",
    actorIds?: string[],
  ) {
    const query = this.interactions
      .createQueryBuilder("interaction")
      .select(
        "COALESCE(interaction.user_id, interaction.session_id)",
        "actorId",
      )
      .addSelect("BOOL_OR(interaction.user_id IS NOT NULL)", "isUser")
      .addSelect("MAX(interaction.occurred_at)", "lastInteractionAt")
      .addSelect("COUNT(*)", "events")
      .addSelect(
        "COUNT(*) FILTER (WHERE interaction.interaction_type = 'PRODUCT_CLICKED')",
        "clicks",
      )
      .addSelect(
        "COUNT(*) FILTER (WHERE interaction.interaction_type = 'PRODUCT_ADDED_TO_CART')",
        "cartAdds",
      )
      .where("interaction.occurred_at >= :from", { from })
      .andWhere("interaction.occurred_at < :to", { to })
      .andWhere("interaction.recommendation_request_id IS NOT NULL")
      .andWhere(
        "COALESCE(interaction.user_id, interaction.session_id) IS NOT NULL",
      )
      .groupBy("COALESCE(interaction.user_id, interaction.session_id)");
    if (actorType === "USER") {
      query.andWhere("interaction.user_id IS NOT NULL");
    } else if (actorType === "SESSION") {
      query.andWhere("interaction.user_id IS NULL");
    }
    if (actorIds) {
      query.andWhere("interaction.user_id IN (:...actorIds)", { actorIds });
    }
    const rows = await query
      .orderBy('"lastInteractionAt"', "DESC")
      .addOrderBy('"actorId"', "ASC")
      .offset((page - 1) * pageSize)
      .limit(pageSize)
      .getRawMany<{
        actorId: string;
        isUser: boolean;
        lastInteractionAt: Date;
        events: string;
        clicks: string;
        cartAdds: string;
      }>();
    const count = await this.interactions
      .createQueryBuilder("countInteraction")
      .select(
        "COUNT(DISTINCT COALESCE(countInteraction.user_id, countInteraction.session_id))",
        "count",
      )
      .where("countInteraction.occurred_at >= :from", { from })
      .andWhere("countInteraction.occurred_at < :to", { to })
      .andWhere("countInteraction.recommendation_request_id IS NOT NULL")
      .andWhere(
        "COALESCE(countInteraction.user_id, countInteraction.session_id) IS NOT NULL",
      )
      .andWhere(
        actorType === "USER"
          ? "countInteraction.user_id IS NOT NULL"
          : actorType === "SESSION"
            ? "countInteraction.user_id IS NULL"
            : "1 = 1",
      )
      .andWhere(
        actorIds ? "countInteraction.user_id IN (:...actorIds)" : "1 = 1",
        { actorIds },
      )
      .getRawOne<{ count: string }>();
    return {
      items: rows.map((row) => ({
        actorId: row.actorId,
        actorType:
          row.isUser === true || String(row.isUser) === "true"
            ? "USER"
            : "SESSION",
        lastInteractionAt: new Date(row.lastInteractionAt).toISOString(),
        events: Number(row.events),
        clicks: Number(row.clicks),
        cartAdds: Number(row.cartAdds),
      })),
      page,
      pageSize,
      total: Number(count?.count ?? 0),
    };
  }

  // Lấy activity bounded của một user; không cho endpoint này nhận session để tránh lộ hành vi guest không liên quan.
  async getUserActivity(
    userId: string,
    page: number,
    pageSize: number,
    from?: Date,
    to?: Date,
  ) {
    // Chỉ lấy event có recommendation_request_id để bảng Activity không trộn
    // hành vi từ listing/search thông thường với hiệu quả của recommendation.
    const activityQuery = this.interactions
      .createQueryBuilder("interaction")
      .where("interaction.user_id = :userId", { userId })
      .andWhere("interaction.recommendation_request_id IS NOT NULL")
      .andWhere(from ? "interaction.occurred_at >= :from" : "1 = 1", { from })
      .andWhere(to ? "interaction.occurred_at < :to" : "1 = 1", { to })
      .orderBy("interaction.occurred_at", "DESC")
      .addOrderBy("interaction.event_id", "DESC");
    const countQuery = this.interactions
      .createQueryBuilder("interaction")
      .select("COUNT(*)", "count")
      .where("interaction.user_id = :userId", { userId })
      .andWhere("interaction.recommendation_request_id IS NOT NULL")
      .andWhere(from ? "interaction.occurred_at >= :from" : "1 = 1", { from })
      .andWhere(to ? "interaction.occurred_at < :to" : "1 = 1", { to });
    const [rows, count] = await Promise.all([
      activityQuery
        .offset((page - 1) * pageSize)
        .limit(pageSize)
        .getMany(),
      countQuery.getRawOne<{ count: string }>(),
    ]);
    const productSnapshots = await this.catalogProducts.findSnapshots(
      rows.map((row) => row.productId ?? ""),
    );
    const productsById = new Map(
      productSnapshots.map((product) => [product.productId, product]),
    );

    return {
      items: rows.map((row) => ({
        eventId: row.eventId,
        interactionType: row.interactionType,
        productId: row.productId,
        productName: row.productId
          ? (productsById.get(row.productId)?.name ?? null)
          : null,
        productImageUrl: row.productId
          ? (productsById.get(row.productId)?.imageUrl ?? null)
          : null,
        recommendationRequestId: row.recommendationRequestId,
        recommendationSource: row.recommendationSource,
        recommendationRank: row.recommendationRank,
        surface: row.surface,
        occurredAt: row.occurredAt.toISOString(),
      })),
      page,
      pageSize,
      total: Number(count?.count ?? 0),
    };
  }

  findActivePolicy(): Promise<RecommendationPolicyEntity | null> {
    return this.policies.findOne({
      where: { status: "ACTIVE" },
      order: { createdAt: "DESC" },
    });
  }

  findPolicyHistory(limit: number): Promise<RecommendationPolicyEntity[]> {
    return this.policies.find({ order: { createdAt: "DESC" }, take: limit });
  }

  // Archive và insert policy mới trong cùng transaction để không có khoảng trống active khi DB lỗi giữa chừng.
  activatePolicy(
    policy: Partial<RecommendationPolicyEntity>,
  ): Promise<RecommendationPolicyEntity> {
    return this.dataSource.transaction(async (manager) => {
      const policyRepository = manager.getRepository(
        RecommendationPolicyEntity,
      );
      // PostgreSQL advisory lock serialize hai admin update/rollback giữa nhiều instance của Recommendation Service.
      await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "recommendation-policy-active",
      ]);
      await policyRepository.update(
        { status: "ACTIVE" },
        { status: "ARCHIVED" },
      );
      return policyRepository.save(policy);
    });
  }

  // Aggregate A/B attribution theo experiment và variant để Admin đánh giá trước khi thay traffic.
  async getExperiments(from: Date, to: Date) {
    const rows = await this.interactions
      .createQueryBuilder("interaction")
      .select("interaction.recommendation_experiment_id", "experimentId")
      .addSelect("interaction.recommendation_experiment_variant", "variant")
      .addSelect("COUNT(*)", "events")
      .addSelect(
        "COUNT(*) FILTER (WHERE interaction.interaction_type = 'PRODUCT_IMPRESSED')",
        "impressions",
      )
      .addSelect(
        "COUNT(*) FILTER (WHERE interaction.interaction_type = 'PRODUCT_CLICKED')",
        "clicks",
      )
      .addSelect(
        "COUNT(*) FILTER (WHERE interaction.interaction_type = 'PRODUCT_ADDED_TO_CART')",
        "cartAdds",
      )
      .where("interaction.occurred_at >= :from", { from })
      .andWhere("interaction.occurred_at < :to", { to })
      .andWhere("interaction.recommendation_experiment_id IS NOT NULL")
      .groupBy("interaction.recommendation_experiment_id")
      .addGroupBy("interaction.recommendation_experiment_variant")
      // Alias camelCase phải được quote; nếu không PostgreSQL sẽ tìm experimentid viết thường.
      .orderBy('"experimentId"', "ASC")
      .addOrderBy("variant", "ASC")
      .getRawMany<{
        experimentId: string;
        variant: string;
        events: string;
        impressions: string;
        clicks: string;
        cartAdds: string;
      }>();
    return rows.map((row) => ({
      experimentId: row.experimentId,
      variant: row.variant,
      events: Number(row.events),
      impressions: Number(row.impressions),
      clicks: Number(row.clicks),
      cartAdds: Number(row.cartAdds),
      clickThroughRate:
        Number(row.impressions) > 0
          ? Number((Number(row.clicks) / Number(row.impressions)).toFixed(4))
          : 0,
      clickToCartRate:
        Number(row.clicks) > 0
          ? Number((Number(row.cartAdds) / Number(row.clicks)).toFixed(4))
          : 0,
    }));
  }
}
