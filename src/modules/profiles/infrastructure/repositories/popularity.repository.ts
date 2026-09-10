// Repository này ghi popularity aggregate; PopularityService chỉ tính tín hiệu nghiệp vụ từ event.

import { Injectable } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";

// Adapter persistence cho counter và score popularity theo product.
@Injectable()
export class PopularityRepository {
  constructor(private readonly dataSource: DataSource) {}

  // Cộng các counter interaction trong transaction đang xử lý profile projection nếu có.
  async incrementInteraction(
    input: {
      productId: string;
      views: number;
      clicks: number;
      cartAdds: number;
    },
    manager?: EntityManager,
  ): Promise<void> {
    const executor = manager ?? this.dataSource.manager;
    await executor.query(
      `INSERT INTO recommendation_product_popularity_daily (product_id, bucket_date, views, clicks, cart_adds)
       VALUES ($1::varchar, CURRENT_DATE, $2::integer, $3::integer, $4::integer)
       ON CONFLICT (product_id, bucket_date)
       DO UPDATE SET views = recommendation_product_popularity_daily.views + $2::integer,
                     clicks = recommendation_product_popularity_daily.clicks + $3::integer,
                     cart_adds = recommendation_product_popularity_daily.cart_adds + $4::integer`,
      [input.productId, input.views, input.clicks, input.cartAdds],
    );
    await executor.query(
      `INSERT INTO recommendation_product_popularity (product_id, views_1d, views_7d, clicks_1d, cart_adds_7d, popularity_score)
       VALUES ($1::varchar, $2::integer, $2::integer, $3::integer, $4::integer,
               $2::double precision * 0.1 + $3::double precision * 0.5 + $4::double precision * 2)
       ON CONFLICT (product_id)
       DO UPDATE SET views_1d = recommendation_product_popularity.views_1d + $2::integer,
                     views_7d = recommendation_product_popularity.views_7d + $2::integer,
                     clicks_1d = recommendation_product_popularity.clicks_1d + $3::integer,
                     cart_adds_7d = recommendation_product_popularity.cart_adds_7d + $4::integer,
                     popularity_score = recommendation_product_popularity.popularity_score +
                       ($2::double precision * 0.1 + $3::double precision * 0.5 + $4::double precision * 2),
                     calculated_at = now()`,
      [input.productId, input.views, input.clicks, input.cartAdds],
    );
  }

  // Cộng hoặc trừ purchase aggregate theo item quantity, giữ score không âm khi xử lý return.
  async incrementPurchase(
    input: { productId: string; quantity: number; isReturn: boolean },
    manager?: EntityManager,
  ): Promise<void> {
    const signedQuantity = input.isReturn ? -input.quantity : input.quantity;
    const executor = manager ?? this.dataSource.manager;
    await executor.query(
      `INSERT INTO recommendation_product_popularity_daily (product_id, bucket_date, purchases)
       VALUES ($1::varchar, CURRENT_DATE, GREATEST(0, $2::integer))
       ON CONFLICT (product_id, bucket_date)
       DO UPDATE SET purchases = GREATEST(0, recommendation_product_popularity_daily.purchases + $2::integer)`,
      [input.productId, signedQuantity],
    );
    await executor.query(
      `INSERT INTO recommendation_product_popularity (product_id, purchases_30d, popularity_score)
       VALUES ($1::varchar, $2::integer, $2::double precision * 3)
       ON CONFLICT (product_id)
       DO UPDATE SET purchases_30d = GREATEST(0, recommendation_product_popularity.purchases_30d + $2::integer),
                     popularity_score = GREATEST(0, recommendation_product_popularity.popularity_score + ($2::double precision * 3)),
                     calculated_at = now()`,
      [input.productId, signedQuantity],
    );
  }
}
