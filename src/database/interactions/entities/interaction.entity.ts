// Entity này lưu read model interaction do Recommendation Service sở hữu, không tham chiếu trực tiếp database service khác.

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

@Entity("recommendation_interactions")
@Index("idx_recommendation_interactions_user_occurred", ["userId", "occurredAt"])
@Index("idx_recommendation_interactions_session_occurred", ["sessionId", "occurredAt"])
@Index("idx_recommendation_interactions_product_occurred", ["productId", "occurredAt"])
export class RecommendationInteractionEntity {
  // Khóa nội bộ của read model, chỉ phục vụ quan hệ và thao tác persistence trong Recommendation Service.
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  // Định danh bất biến của Kafka event; unique để redelivery không tạo thêm interaction hoặc cộng điểm lần hai.
  @Column({ name: "event_id", type: "varchar", length: 128, unique: true })
  eventId!: string;

  // Tên integration event giúp phân biệt loại message khi audit hoặc replay dữ liệu lịch sử.
  @Column({ name: "event_name", type: "varchar", length: 128 })
  eventName!: string;

  // Version của payload để validator và các đợt migrate sau này biết cách đọc event tương ứng.
  @Column({ name: "event_version", type: "integer" })
  eventVersion!: number;

  // Service phát event, dùng để truy nguyên nguồn dữ liệu mà không cần lưu toàn bộ request gốc.
  @Column({ type: "varchar", length: 128 })
  source!: string;

  // Thời điểm người dùng thực sự tương tác; ranking dùng thời điểm này cho decay thay vì thời điểm consumer nhận message.
  @Column({ name: "occurred_at", type: "timestamptz" })
  occurredAt!: Date;

  // User đã xác thực; nullable vì guest chỉ có sessionId và không được suy đoán danh tính.
  @Column({ name: "user_id", type: "varchar", length: 128, nullable: true })
  userId!: string | null;

  // Định danh phiên guest hoặc phiên hiện tại; là khóa để xây session intent trong Redis trước khi login.
  @Column({ name: "session_id", type: "varchar", length: 128, nullable: true })
  sessionId!: string | null;

  // Loại hành vi như view, click, impression, search hoặc cart; là đầu vào để tính trọng số profile.
  @Column({ name: "interaction_type", type: "varchar", length: 64 })
  interactionType!: string;

  // Sản phẩm liên quan đến hành vi; nullable cho event search hoặc interaction không gắn với một product cụ thể.
  @Column({ name: "product_id", type: "varchar", length: 128, nullable: true })
  productId!: string | null;

  // Variant người dùng xem hoặc thêm vào giỏ, giúp giữ ngữ cảnh chi tiết nhưng không dùng làm product candidate riêng.
  @Column({ name: "variant_id", type: "varchar", length: 128, nullable: true })
  variantId!: string | null;

  // Category tại thời điểm interaction; dùng làm fallback khi catalog read model chưa kịp đồng bộ.
  @Column({ name: "category_id", type: "varchar", length: 128, nullable: true })
  categoryId!: string | null;

  // Nội dung search đã chuẩn hóa; nullable với hành vi không phát sinh truy vấn và có thể dùng để học query preference.
  @Column({ type: "varchar", length: 255, nullable: true })
  query!: string | null;

  // Bề mặt hoặc route nơi hành vi phát sinh, ví dụ home, product detail hoặc recommendations page.
  @Column({ type: "varchar", length: 80, nullable: true })
  page!: string | null;

  // Vị trí hiển thị của sản phẩm trong listing; phục vụ phân tích impression/click theo vị trí.
  @Column({ type: "integer", nullable: true })
  position!: number | null;

  // Số lượng thay đổi trong cart; dùng để tăng/giảm tín hiệu cart theo mức độ tương tác.
  @Column({ type: "integer", nullable: true })
  quantity!: number | null;

  // Request ID từ Gateway để nối interaction với log và trace của một HTTP request.
  @Column({ name: "request_id", type: "varchar", length: 128, nullable: true })
  requestId!: string | null;

  // ID của lần recommendation đã sinh ra card này; dùng để đo hiệu quả của từng result set.
  @Column({ name: "recommendation_request_id", type: "varchar", length: 128, nullable: true })
  recommendationRequestId!: string | null;

  // ID item trong recommendation result; thường gắn với product để theo dõi impression → click → cart.
  @Column({ name: "recommendation_item_id", type: "varchar", length: 128, nullable: true })
  recommendationItemId!: string | null;

  // Nguồn candidate đã tạo ra item, ví dụ category affinity, trending hoặc explore.
  @Column({ name: "recommendation_source", type: "varchar", length: 80, nullable: true })
  recommendationSource!: string | null;

  // Thứ hạng item lúc hiển thị; giúp đánh giá vị trí nào tạo ra click hoặc conversion tốt hơn.
  @Column({ name: "recommendation_rank", type: "integer", nullable: true })
  recommendationRank!: number | null;

  // Surface recommendation chính thức để phân biệt cùng một product trên home, detail và trang gợi ý.
  @Column({ type: "varchar", length: 32, nullable: true })
  surface!: string | null;

  // Metadata trace tối thiểu; không dùng để thay thế các cột truy vấn chính và không chứa token/PII nhạy cảm.
  @Column({ type: "jsonb", default: {} })
  metadata!: Record<string, string>;

  // Trạng thái xử lý persistence; PROCESSED là mặc định, FAILED dành cho cơ chế audit/recovery nếu mở rộng sau này.
  @Column({ name: "processing_status", type: "varchar", length: 32, default: "PROCESSED" })
  processingStatus!: "PROCESSED" | "FAILED";

  // Lý do xử lý thất bại, nullable vì event thành công không cần lưu error detail.
  @Column({ name: "processing_error", type: "text", nullable: true })
  processingError!: string | null;

  // Thời điểm Recommendation nhận event, dùng để đo ingestion lag so với occurredAt.
  @CreateDateColumn({ name: "received_at", type: "timestamptz" })
  receivedAt!: Date;

  // Thời điểm hoàn tất xử lý event; nullable để phân biệt message mới nhận hoặc đang chờ retry.
  @Column({ name: "processed_at", type: "timestamptz", nullable: true })
  processedAt!: Date | null;
}
