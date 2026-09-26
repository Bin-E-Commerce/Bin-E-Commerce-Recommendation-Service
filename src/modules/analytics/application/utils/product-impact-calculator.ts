// File này tính baseline, after-impact và daily buckets từ event rows đã được repository lọc.
// Nó không query database, không validate quyền và không thay đổi dữ liệu; service chỉ điều phối các bước này.

import type { ProductImpactEventRow } from '@/modules/analytics/infrastructure/product-impact.repository';
import type { ProductImpactComparisonDto } from '@/modules/analytics/presentation/dto/product-impact.dto';
import type {
    ProductImpactDaily,
    ProductImpactItem,
    ProductImpactMetric,
} from '@/modules/analytics/application/types/product-impact.types';
import {
    createProductImpactDateRange,
    parseProductImpactTimestamp,
} from '@/modules/analytics/application/utils/product-impact-time.util';

type DayTotal = {
    views: number;
    sales: number;
};

// Gom các event theo ngày UTC để baseline và after-impact không phụ thuộc số lượng event lẻ trong ngày.
function groupEventsByUtcDay(
    rows: ProductImpactEventRow[],
): Map<string, DayTotal> {
    const totals = new Map<string, DayTotal>();

    for (const row of rows) {
        const date = parseProductImpactTimestamp(row.occurredAt)
            .toISOString()
            .slice(0, 10);
        const current = totals.get(date) ?? { views: 0, sales: 0 };
        current.views += row.views;
        current.sales += row.sales;
        totals.set(date, current);
    }

    return totals;
}

// Giữ product boundary sau khi repository trả về một batch nhiều sản phẩm.
function selectProductRows(
    rows: ProductImpactEventRow[],
    productId: string,
): ProductImpactEventRow[] {
    return rows.filter((row) => row.productId === productId);
}

// Tính baseline theo timestamp thực tế và trung bình trên số ngày có dữ liệu lịch sử.
function buildBeforeMetric(
    rows: ProductImpactEventRow[],
    comparison: ProductImpactComparisonDto,
): ProductImpactMetric {
    const from = comparison.beforeFrom
        ? parseProductImpactTimestamp(comparison.beforeFrom).getTime()
        : null;
    const to = parseProductImpactTimestamp(comparison.beforeTo).getTime();
    const baselineRows = rows.filter((row) => {
        const occurredAt = parseProductImpactTimestamp(
            row.occurredAt,
        ).getTime();
        return (from === null || occurredAt >= from) && occurredAt < to;
    });
    const daily = groupEventsByUtcDay(baselineRows);
    const views = baselineRows.reduce((total, row) => total + row.views, 0);
    const sales = baselineRows.reduce((total, row) => total + row.sales, 0);
    const daysWithData = daily.size;

    return {
        views,
        sales,
        daysWithData,
        averageViews: Number((views / Math.max(1, daysWithData)).toFixed(2)),
        averageSales: Number((sales / Math.max(1, daysWithData)).toFixed(2)),
    };
}

// Tính after-impact theo timestamp rồi lấp ngày trống để UI phân biệt zero thật với ngày chưa có event.
function buildAfterMetric(
    rows: ProductImpactEventRow[],
    comparison: ProductImpactComparisonDto,
): { metric: ProductImpactMetric; daily: ProductImpactDaily[] } {
    const from = parseProductImpactTimestamp(comparison.afterFrom).getTime();
    const to = parseProductImpactTimestamp(comparison.afterTo).getTime();
    const afterRows = rows.filter((row) => {
        const occurredAt = parseProductImpactTimestamp(
            row.occurredAt,
        ).getTime();
        return occurredAt >= from && occurredAt < to;
    });
    const totalsByDay = groupEventsByUtcDay(afterRows);
    const daily = createProductImpactDateRange(
        comparison.afterFrom,
        comparison.afterTo,
    ).map((date) => {
        const total = totalsByDay.get(date);
        return {
            date,
            views: total?.views ?? 0,
            sales: total?.sales ?? 0,
            hasData: Boolean(total),
        };
    });
    const latest = [...daily].reverse().find((item) => item.hasData) ?? {
        views: 0,
        sales: 0,
    };
    const views = daily.reduce((total, item) => total + item.views, 0);
    const sales = daily.reduce((total, item) => total + item.sales, 0);

    return {
        metric: {
            views: latest.views,
            sales: latest.sales,
            daysWithData: totalsByDay.size,
            averageViews: Number(
                (views / Math.max(1, daily.length)).toFixed(2),
            ),
            averageSales: Number(
                (sales / Math.max(1, daily.length)).toFixed(2),
            ),
        },
        daily,
    };
}

// Kết hợp phép tính trước/sau thành item response duy nhất cho một sản phẩm.
export function buildProductImpactItem(
    rows: ProductImpactEventRow[],
    comparison: ProductImpactComparisonDto,
): ProductImpactItem {
    const productRows = selectProductRows(rows, comparison.productId);
    const before = buildBeforeMetric(productRows, comparison);
    const after = buildAfterMetric(productRows, comparison);

    return {
        key: comparison.key,
        productId: comparison.productId,
        before,
        after: after.metric,
        daily: after.daily,
    };
}
