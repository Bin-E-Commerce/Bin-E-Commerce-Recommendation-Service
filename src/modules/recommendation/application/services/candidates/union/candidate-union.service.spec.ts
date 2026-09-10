import { CandidateUnion } from "./candidate-union.service";
import type { RecommendationCatalogProduct } from "../../../../../catalog/application/types/catalog-product.type";

function product(productId: string): RecommendationCatalogProduct {
  return {
    productId,
    originType: "INTERNAL",
    name: `Product ${productId}`,
    slug: productId,
    imageUrl: null,
    categoryId: null,
    brandId: null,
    sellerShopId: null,
    externalShopId: null,
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
});
