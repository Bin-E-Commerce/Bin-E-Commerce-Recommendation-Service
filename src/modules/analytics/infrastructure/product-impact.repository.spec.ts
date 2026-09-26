// Kiểm tra query aggregate impact giữ đúng product boundary khi chạy batch nhiều comparison.

import type { DataSource } from 'typeorm';
import { ProductImpactRepository } from '@/modules/analytics/infrastructure/product-impact.repository';
import type { ProductImpactComparisonDto } from '@/modules/analytics/presentation/dto/product-impact.dto';

describe('ProductImpactRepository', () => {
    // Dùng fake DataSource để test query shape và mapping mà không cần khởi động PostgreSQL.
    function createDataSource() {
        return {
            query: jest.fn().mockResolvedValue([
                {
                    productId: 'product-1',
                    occurredAt: '2026-01-15T08:00:00.000Z',
                    views: '10',
                    sales: '1',
                },
            ]),
        } as unknown as DataSource & { query: jest.Mock };
    }

    // Mỗi product phải xuất hiện trong branch cùng điều kiện ngày của chính nó,
    // nếu không khoảng thời gian của product khác có thể bị đọc nhầm vào cùng batch.
    it('keeps product id and date bounds in every daily branch', async () => {
        const dataSource = createDataSource();
        const repository = new ProductImpactRepository(dataSource);
        const comparisons: ProductImpactComparisonDto[] = [
            {
                key: 'product-1-job',
                productId: '00000000-0000-0000-0000-000000000001',
                beforeFrom: '2026-01-01T00:00:00.000Z',
                beforeTo: '2026-01-31T00:00:00.000Z',
                afterFrom: '2026-01-31T00:00:00.000Z',
                afterTo: '2026-03-02T00:00:00.000Z',
            },
            {
                key: 'product-2-job',
                productId: '00000000-0000-0000-0000-000000000002',
                beforeFrom: '2026-02-01T00:00:00.000Z',
                beforeTo: '2026-03-03T00:00:00.000Z',
                afterFrom: '2026-03-03T00:00:00.000Z',
                afterTo: '2026-04-02T00:00:00.000Z',
            },
        ];

        const rows = await repository.compare(comparisons);
        const [sql, parameters] = dataSource.query.mock.calls[0] as [
            string,
            string[],
        ];

        expect(sql).toContain('interaction.product_id = $1');
        expect(sql).toContain('purchase.product_id = $5');
        expect(parameters).toHaveLength(8);
        expect(rows[0]).toMatchObject({
            productId: 'product-1',
            occurredAt: '2026-01-15T08:00:00.000Z',
            views: 10,
            sales: 1,
        });
    });
});
