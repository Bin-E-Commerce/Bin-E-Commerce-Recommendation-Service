// Entity này lưu popularity theo từng ngày để Recommendation có thể tính rolling window 1/7/30 ngày mà không cộng dồn vô hạn.

import { Column, Entity, Index, PrimaryColumn } from "typeorm";

@Entity({ name: "recommendation_product_popularity_daily" })
@Index("IDX_recommendation_popularity_daily_bucket", ["bucketDate"])
export class RecommendationPopularityDailyEntity {
  @PrimaryColumn({ name: "product_id", type: "varchar", length: 128 })
  productId: string;

  @PrimaryColumn({ name: "bucket_date", type: "date" })
  bucketDate: string;

  @Column({ name: "views", type: "integer", default: 0 })
  views: number;

  @Column({ name: "clicks", type: "integer", default: 0 })
  clicks: number;

  @Column({ name: "cart_adds", type: "integer", default: 0 })
  cartAdds: number;

  @Column({ name: "purchases", type: "integer", default: 0 })
  purchases: number;
}
