// Entity này giữ aggregate popularity theo product để trending dùng cửa sổ thời gian thay vì tổng view vĩnh viễn.

import { Column, Entity, PrimaryColumn, UpdateDateColumn } from "typeorm";

@Entity("recommendation_product_popularity")
export class RecommendationPopularityEntity {
  // Product ID làm khóa chính aggregate; bảng này chỉ lưu thống kê recommendation, không sở hữu Product entity.
  @PrimaryColumn({ name: "product_id", type: "varchar", length: 128 })
  productId!: string;

  // Số lượt view trong cửa sổ một ngày, dùng để phản ánh nhu cầu rất gần hiện tại.
  @Column({ name: "views_1d", type: "integer", default: 0 })
  views1d!: number;

  // Số lượt view trong cửa sổ bảy ngày, ổn định hơn views1d khi traffic biến động ngắn hạn.
  @Column({ name: "views_7d", type: "integer", default: 0 })
  views7d!: number;

  // Số lượt click trong một ngày, tín hiệu có ý định cao hơn impression hoặc view.
  @Column({ name: "clicks_1d", type: "integer", default: 0 })
  clicks1d!: number;

  // Số lần thêm vào giỏ trong bảy ngày, dùng làm tín hiệu cân nhắc mua mạnh hơn click.
  @Column({ name: "cart_adds_7d", type: "integer", default: 0 })
  cartAdds7d!: number;

  // Số lượng sản phẩm đã mua trong ba mươi ngày, giúp best-selling/trending phản ánh conversion thực tế.
  @Column({ name: "purchases_30d", type: "integer", default: 0 })
  purchases30d!: number;

  // Điểm popularity tổng hợp từ các counter; candidate query dùng điểm này để lấy trending theo thời gian.
  @Column({ name: "popularity_score", type: "double precision", default: 0 })
  popularityScore!: number;

  // Thời điểm aggregate được tính/cập nhật gần nhất, dùng kiểm tra độ mới của popularity read model.
  @UpdateDateColumn({ name: "calculated_at", type: "timestamptz" })
  calculatedAt!: Date;
}
