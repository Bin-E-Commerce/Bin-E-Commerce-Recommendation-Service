// Kiểm tra phép tính baseline trung bình và việc lấp ngày trống của analytics impact.
/// <reference types="jest" />

import { ProductImpactService } from "./product-impact.service";
import type { ProductImpactRepository } from "../infrastructure/product-impact.repository";

describe("ProductImpactService", () => {
  let target: ProductImpactService;
  let mockRepository: { compare: jest.Mock };

  beforeEach(() => {
    // Arrange: mock repository để test chỉ tập trung vào business calculation.
    mockRepository = { compare: jest.fn() };
    target = new ProductImpactService(
      mockRepository as unknown as ProductImpactRepository,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // Baseline lấy đúng số bucket lịch sử thực tế; ngày không có bucket không được giả thành dữ liệu.
  it("should compare the same number of post-optimization days as historical baseline buckets", async () => {
    // Arrange
    mockRepository.compare.mockResolvedValue([
      {
        productId: "product-1",
        occurredAt: "2026-09-05T08:00:00.000Z",
        views: 40,
        sales: 2,
      },
      {
        productId: "product-1",
        occurredAt: "2026-09-21T08:00:00.000Z",
        views: 12,
        sales: 1,
      },
      {
        productId: "product-1",
        occurredAt: "2026-09-23T08:00:00.000Z",
        views: 20,
        sales: 0,
      },
    ]);

    // Act
    const result = await target.compare({
      comparisons: [
        {
          key: "product-1-job",
          productId: "product-1",
          beforeFrom: null,
          beforeTo: "2026-09-21T00:00:00.000Z",
          afterFrom: "2026-09-21T00:00:00.000Z",
          afterTo: "2026-09-24T00:00:00.000Z",
        },
      ],
    });

    // Assert
    expect(result.items[0]).toEqual({
      key: "product-1-job",
      productId: "product-1",
      before: {
        views: 40,
        sales: 2,
        daysWithData: 1,
        averageViews: 40,
        averageSales: 2,
      },
      after: {
        views: 20,
        sales: 0,
        daysWithData: 2,
        averageViews: 10.67,
        averageSales: 0.33,
      },
      daily: [
        { date: "2026-09-21", views: 12, sales: 1, hasData: true },
        { date: "2026-09-22", views: 0, sales: 0, hasData: false },
        { date: "2026-09-23", views: 20, sales: 0, hasData: true },
      ],
    });
    expect(mockRepository.compare).toHaveBeenCalledTimes(1);
  });

  // Timestamp apply phải tách được event trước/sau dù hai nhóm cùng nằm trong một bucket ngày UTC.
  it("separates events around an apply timestamp on the same day", async () => {
    mockRepository.compare.mockResolvedValue([
      {
        productId: "00000000-0000-0000-0000-000000000001",
        occurredAt: "2026-09-18T11:00:00.000Z",
        views: 3,
        sales: 2,
      },
      {
        productId: "00000000-0000-0000-0000-000000000001",
        occurredAt: "2026-09-18T13:32:15.000Z",
        views: 1,
        sales: 0,
      },
      {
        productId: "00000000-0000-0000-0000-000000000001",
        occurredAt: "2026-09-18T13:32:21.000Z",
        views: 4,
        sales: 1,
      },
    ]);

    const result = await target.compare({
      comparisons: [
        {
          key: "product-1-job",
          productId: "00000000-0000-0000-0000-000000000001",
          beforeFrom: null,
          beforeTo: "2026-09-18T13:32:15.000Z",
          afterFrom: "2026-09-18T13:32:15.000Z",
          afterTo: "2026-09-18T13:33:00.000Z",
        },
      ],
    });

    const item = result.items[0];
    expect(item).toBeDefined();

    expect(item?.before).toMatchObject({
      views: 3,
      sales: 2,
      daysWithData: 1,
      averageViews: 3,
      averageSales: 2,
    });
    expect(item?.after).toMatchObject({
      views: 5,
      sales: 1,
      daysWithData: 1,
    });
    expect(item?.daily).toEqual([
      { date: "2026-09-18", views: 5, sales: 1, hasData: true },
    ]);
  });
});
