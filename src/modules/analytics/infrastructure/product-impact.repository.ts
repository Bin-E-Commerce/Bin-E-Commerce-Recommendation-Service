// Repository đọc event popularity theo timestamp; không truy cập Product/Order master database.

import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { ProductImpactComparisonDto } from '@/modules/analytics/presentation/dto/product-impact.dto';

export type ProductImpactEventRow = {
    productId: string;
    occurredAt: string;
    views: number;
    sales: number;
};

// Đọc event view và purchase trong một batch để mốc apply có thể chính xác đến giây.
@Injectable()
export class ProductImpactRepository {
    constructor(private readonly dataSource: DataSource) {}

    // Mỗi comparison có range riêng; query chỉ lấy event thuộc product và không trộn dữ liệu giữa các job.
    async compare(
        comparisons: ProductImpactComparisonDto[],
    ): Promise<ProductImpactEventRow[]> {
        if (comparisons.length === 0) return [];

        const parameters: Array<string | null> = [];
        const interactionBranches: string[] = [];
        const purchaseBranches: string[] = [];
        comparisons.forEach((comparison, index) => {
            const offset = index * 4;
            const productParam = `$${offset + 1}`;
            const beforeFromParam = `$${offset + 2}`;
            const afterToParam = `$${offset + 4}`;
            parameters.push(
                comparison.productId,
                comparison.beforeFrom,
                comparison.beforeTo,
                comparison.afterTo,
            );

            const range = (alias: string) => `(
        ${alias}.product_id = ${productParam}
        AND (${beforeFromParam}::timestamptz IS NULL OR ${alias}.occurred_at >= ${beforeFromParam}::timestamptz)
        AND ${alias}.occurred_at < ${afterToParam}::timestamptz
      )`;
            interactionBranches.push(range('interaction'));
            purchaseBranches.push(range('purchase'));
        });

        const rows = await this.dataSource.query<ProductImpactEventRow[]>(
            `SELECT
         event.product_id AS "productId",
         event.occurred_at AS "occurredAt",
         event.views AS "views",
         event.sales AS "sales"
       FROM (
         SELECT
           interaction.product_id,
           interaction.occurred_at,
           CASE
             WHEN interaction.interaction_type IN ('PRODUCT_VIEWED', 'PRODUCT_IMPRESSED') THEN 1
             ELSE 0
           END AS views,
           0 AS sales
         FROM recommendation_interactions interaction
         WHERE interaction.interaction_type IN ('PRODUCT_VIEWED', 'PRODUCT_IMPRESSED')
           AND (${interactionBranches.join(' OR ')})

         UNION ALL

         SELECT
           purchase.product_id,
           purchase.occurred_at,
           0 AS views,
           purchase.purchase_completed AS sales
         FROM recommendation_product_popularity_events purchase
         WHERE ${purchaseBranches.join(' OR ')}

         UNION ALL

         -- Giữ baseline mua hàng lịch sử trước khi event store được triển khai.
         -- Không dùng daily cho ngày có event chính xác để tránh cộng trùng và tuyệt đối không dùng nó cho phần sau apply.
         SELECT
           legacy.product_id,
           legacy.bucket_date::timestamptz,
           0 AS views,
           legacy.purchase_completed AS sales
         FROM recommendation_product_popularity_daily legacy
         WHERE legacy.purchase_completed <> 0
           AND (
             ${comparisons
                 .map((comparison, index) => {
                     const offset = index * 4;
                     const productParam = `$${offset + 1}`;
                     const beforeFromParam = `$${offset + 2}`;
                     const beforeToParam = `$${offset + 3}`;
                     return `(
                   legacy.product_id = ${productParam}
                   AND legacy.bucket_date < (${beforeToParam}::timestamptz AT TIME ZONE 'UTC')::date
                   AND (${beforeFromParam}::timestamptz IS NULL OR legacy.bucket_date >= (${beforeFromParam}::timestamptz AT TIME ZONE 'UTC')::date)
                   AND NOT EXISTS (
                     SELECT 1
                     FROM recommendation_product_popularity_events exact_purchase
                     WHERE exact_purchase.product_id = legacy.product_id
                       AND (exact_purchase.occurred_at AT TIME ZONE 'UTC')::date = legacy.bucket_date
                   )
                 )`;
                 })
                 .join(' OR ')}
           )
       ) event
       ORDER BY event.product_id, event.occurred_at`,
            parameters,
        );

        return rows.map((row) => ({
            productId: String(row.productId),
            occurredAt: new Date(row.occurredAt).toISOString(),
            views: Number(row.views),
            sales: Number(row.sales),
        }));
    }

    // Validate range ở repository như lớp bảo vệ cuối khi method được gọi từ test hoặc adapter khác.
    static assertValidRange(comparison: ProductImpactComparisonDto): void {
        const beforeFrom = comparison.beforeFrom
            ? Date.parse(comparison.beforeFrom)
            : null;
        const beforeTo = Date.parse(comparison.beforeTo);
        const afterFrom = Date.parse(comparison.afterFrom);
        const afterTo = Date.parse(comparison.afterTo);
        if (!(
            (beforeFrom === null || beforeFrom < beforeTo) &&
            beforeTo <= afterFrom &&
            afterFrom < afterTo
        )) {
            throw new BadRequestException('Invalid product impact date range');
        }
    }
}
