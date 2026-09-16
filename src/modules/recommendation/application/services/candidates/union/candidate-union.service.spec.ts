// File này kiểm thử invariant deduplicate và exclusion cuối của candidate union trước ranking.
/// <reference types="jest" />

import { CandidateUnion } from "./candidate-union.service";
import type { RecommendationCatalogProduct } from "../../../../../catalog/application/types/catalog-product.type";

// Tạo read model tối thiểu để test union tập trung vào shop identity và attribution.
function product(
  productId: string,
  shop: {
    sellerShopId?: string | null;
    externalShopId?: string | null;
    originType?: "INTERNAL" | "EXTERNAL";
  } = {},
): RecommendationCatalogProduct {
  return {
    productId,
    originType: shop.originType ?? "INTERNAL",
    name: `Product ${productId}`,
    slug: productId,
    imageUrl: null,
    categoryId: null,
    brandId: null,
    sellerShopId: shop.sellerShopId ?? null,
    externalShopId: shop.externalShopId ?? null,
    minPrice: "100",
    maxPrice: "100",
    ratingAvg: null,
    reviewCount: 0,
    totalSold: 0,
    status: "ACTIVE",
    isInStock: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    catalogVersion: "1",
    shortDescription: null,
    description: null,
    brandName: null,
    categoryPath: null,
    semanticAttributes: [],
    contentHash: null,
    embeddingStatus: "NOT_REQUIRED",
    embeddingModelVersion: null,
    embeddingDimensions: null,
  };
}

describe("CandidateUnion", () => {
  // Đảm bảo deduplicate product không làm mất attribution từ nhiều relation type.
  it("preserves every relation contribution for one product", () => {
    const union = new CandidateUnion(new Set(), 10);

    // Arrange: cùng một product được tìm thấy bởi nhiều anchor/relation type.
    union.add(
      [product("p-1")],
      "CO_BEHAVIOR",
      new Map([
        [
          "p-1",
          [
            {
              rawScore: 6,
              reasonCode: "CO_PURCHASE",
              anchorProductId: "anchor-purchase",
              relationType: "CO_PURCHASE" as const,
            },
            {
              rawScore: 3,
              reasonCode: "CO_CART",
              anchorProductId: "anchor-cart",
              relationType: "CO_CART" as const,
            },
          ],
        ],
      ]),
    );

    // Act: đọc candidate sau khi union deduplicate theo productId.
    const [candidate] = union.values();

    // Assert: deduplicate product nhưng không làm mất attribution chi tiết.
    expect(candidate?.product.productId).toBe("p-1");
    expect(candidate?.contributions).toHaveLength(2);
    expect(candidate?.contributions?.map((item) => item.relationType)).toEqual([
      "CO_PURCHASE",
      "CO_CART",
    ]);
  });

  // Đảm bảo internal shop exclusion được áp dụng ngay tại lớp union.
  it("excludes products from the current internal shop", () => {
    // Arrange
    const union = new CandidateUnion(new Set(), 10, {
      excludeSellerShopId: "shop-1",
    });

    // Act
    union.add(
      [
        product("same-shop", { sellerShopId: "shop-1" }),
        product("other-shop", { sellerShopId: "shop-2" }),
      ],
      "TRENDING",
    );

    // Assert
    expect(union.values().map((item) => item.product.productId)).toEqual([
      "other-shop",
    ]);
  });

  // Đảm bảo external shop exclusion không bị nhầm với sellerShopId.
  it("excludes products from the current external shop", () => {
    // Arrange
    const union = new CandidateUnion(new Set(), 10, {
      excludeExternalShopId: "external-shop-1",
    });

    // Act
    union.add(
      [
        product("same-external-shop", {
          originType: "EXTERNAL",
          externalShopId: "external-shop-1",
        }),
        product("other-external-shop", {
          originType: "EXTERNAL",
          externalShopId: "external-shop-2",
        }),
        product("same-id-different-namespace", {
          originType: "INTERNAL",
          sellerShopId: "external-shop-1",
        }),
      ],
      "SEMANTIC_SIMILARITY",
    );

    // Assert
    expect(union.values().map((item) => item.product.productId)).toEqual([
      "other-external-shop",
      "same-id-different-namespace",
    ]);
  });
});
