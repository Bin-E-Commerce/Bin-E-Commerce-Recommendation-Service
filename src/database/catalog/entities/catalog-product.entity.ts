// Entity này là catalog read model tối thiểu do Recommendation sở hữu để phục vụ candidate và card response mà không đọc DB Product.

import { Column, Entity, Index, PrimaryColumn } from "typeorm";

@Entity("recommendation_catalog_products")
@Index("idx_recommendation_catalog_status_stock", ["status", "isInStock"])
@Index("idx_recommendation_catalog_category", ["categoryId", "status"])
@Index("idx_recommendation_catalog_brand", ["brandId", "status"])
@Index("idx_recommendation_catalog_origin", ["originType", "status"])
@Index("idx_recommendation_catalog_created", ["createdAt"])
@Index("idx_recommendation_catalog_updated", ["updatedAt"])
@Index("idx_recommendation_catalog_embedding_status", ["embeddingStatus"])
export class RecommendationCatalogProductEntity {
  // Product ID từ Product Service; dùng làm khóa chính của catalog read model và không tạo foreign key cross-service.
  @PrimaryColumn({ name: "product_id", type: "varchar", length: 128 })
  productId!: string;

  // Phân biệt sản phẩm nội bộ có thể checkout với sản phẩm external chỉ phục vụ tham khảo/gợi ý.
  @Column({ name: "origin_type", type: "varchar", length: 16 })
  originType!: "INTERNAL" | "EXTERNAL";

  // Tên hiển thị trên recommendation card; snapshot tại thời điểm catalog event được xử lý.
  @Column({ type: "varchar", length: 500 })
  name!: string;

  // Slug public dùng để tạo URL hoặc định tuyến tới trang chi tiết sản phẩm.
  @Column({ type: "varchar", length: 620 })
  slug!: string;

  // Ảnh đại diện đã chọn từ Product Service; nullable vì sản phẩm có thể chưa có media hợp lệ.
  @Column({ name: "image_url", type: "text", nullable: true })
  imageUrl!: string | null;

  // Category dùng cho category affinity, filter candidate và diversity của danh sách gợi ý.
  @Column({ name: "category_id", type: "varchar", length: 128, nullable: true })
  categoryId!: string | null;

  // Brand dùng để học sở thích thương hiệu và tạo brand-based candidates.
  @Column({ name: "brand_id", type: "varchar", length: 128, nullable: true })
  brandId!: string | null;

  // Shop nội bộ sở hữu sản phẩm; dùng cho diversity để một seller không chiếm toàn bộ result set.
  @Column({ name: "seller_shop_id", type: "varchar", length: 128, nullable: true })
  sellerShopId!: string | null;

  // Shop external nguồn sản phẩm tham khảo; nullable với sản phẩm nội bộ.
  @Column({ name: "external_shop_id", type: "varchar", length: 128, nullable: true })
  externalShopId!: string | null;

  // Mức giá thấp nhất của các variant, dùng hiển thị và làm tín hiệu price range trong tương lai.
  @Column({ name: "min_price", type: "numeric", precision: 14, scale: 2 })
  minPrice!: string;

  // Mức giá cao nhất của các variant để card biết sản phẩm có khoảng giá hay không.
  @Column({ name: "max_price", type: "numeric", precision: 14, scale: 2 })
  maxPrice!: string;

  // Điểm rating trung bình; nullable vì sản phẩm mới có thể chưa có đánh giá.
  @Column({ name: "rating_avg", type: "numeric", precision: 3, scale: 2, nullable: true })
  ratingAvg!: string | null;

  // Số lượng review dùng cùng ratingAvg để đánh giá độ tin cậy của quality score.
  @Column({ name: "review_count", type: "integer", default: 0 })
  reviewCount!: number;

  // Tổng số lượng đã bán, dùng làm baseline best-selling và một phần popularity score.
  @Column({ name: "total_sold", type: "integer", default: 0 })
  totalSold!: number;

  // Trạng thái public của product; chỉ ACTIVE mới được candidate generator đưa vào kết quả.
  @Column({ type: "varchar", length: 16 })
  status!: "ACTIVE" | "INACTIVE" | "DELETED";

  // Snapshot tồn kho để loại sản phẩm hết hàng trước khi ranking và không làm hỏng trải nghiệm click.
  @Column({ name: "is_in_stock", type: "boolean", default: false })
  isInStock!: boolean;

  // Thời điểm sản phẩm được tạo, dùng cho source newest và freshness score.
  @Column({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  // Thời điểm snapshot catalog thay đổi, dùng cho đồng bộ incremental và đánh giá độ mới của read model.
  @Column({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;

  // Version monotonic của catalog event; ngăn event cũ ghi đè snapshot mới hơn khi Kafka đến không đúng thứ tự.
  @Column({ name: "catalog_version", type: "bigint", default: 1 })
  catalogVersion!: string;

  // Mô tả ngắn dùng trong semantic text; không dùng làm nguồn hiển thị authoritative của Product Service.
  @Column({ name: "short_description", type: "text", nullable: true })
  shortDescription!: string | null;

  // Mô tả đã strip HTML, được giới hạn kích thước trước khi tạo embedding.
  @Column({ name: "description", type: "text", nullable: true })
  description!: string | null;

  // Snapshot tên brand để semantic text có ngữ cảnh dễ hiểu hơn brand ID.
  @Column({ name: "brand_name", type: "varchar", length: 255, nullable: true })
  brandName!: string | null;

  // Đường dẫn danh mục đã materialize, ví dụ Electronics > Camera > Tripod.
  @Column({ name: "category_path", type: "text", nullable: true })
  categoryPath!: string | null;

  // Các thuộc tính semantic được giữ dạng JSONB để không tạo schema cứng cho từng ngành hàng.
  @Column({ name: "semantic_attributes", type: "jsonb", default: () => "'[]'::jsonb" })
  semanticAttributes!: Array<{ key: string; value: string }>;

  // Hash ổn định của semantic fields; đổi giá/stock không làm tạo embedding mới.
  @Column({ name: "content_hash", type: "varchar", length: 128, nullable: true })
  contentHash!: string | null;

  // Trạng thái lifecycle embedding được dispatcher và generated-event consumer cập nhật.
  @Column({ name: "embedding_status", type: "varchar", length: 16, default: "NOT_REQUIRED" })
  embeddingStatus!: "NOT_REQUIRED" | "PENDING" | "PROCESSING" | "READY" | "STALE" | "FAILED";

  // Model/dimension của vector hiện tại, dùng để chặn completion stale hoặc sai collection.
  @Column({ name: "embedding_model_version", type: "varchar", length: 128, nullable: true })
  embeddingModelVersion!: string | null;

  @Column({ name: "embedding_dimensions", type: "integer", nullable: true })
  embeddingDimensions!: number | null;
}
