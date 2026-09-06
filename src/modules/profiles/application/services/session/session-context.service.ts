// Service này giữ session intent ngắn hạn trong Redis; mọi lỗi cache đều được chuyển thành context rỗng an toàn.

import { Injectable } from "@nestjs/common";
import { RecommendationRedisService } from "../../../../../infrastructure/redis/redis.module";
import type { SessionContext } from "../../types/profile.types";
import type { RecommendationInteractionRecordedEvent } from "../../../../interactions/application/types/interaction-event.types";

const SESSION_TTL_SECONDS = 24 * 60 * 60;
const MAX_RECENT_ITEMS = 30;

@Injectable()
export class SessionContextService {
  constructor(private readonly redis: RecommendationRedisService) {}

  // Đọc session context để candidate engine hiểu ý định hiện tại của guest/user trong cùng phiên.
  async get(sessionId: string): Promise<SessionContext | null> {
    return this.redis.getJson<SessionContext>(this.key(sessionId));
  }

  // Cập nhật recent products/category/query theo event mới nhất và kéo dài TTL của phiên hoạt động.
  async apply(
    event: RecommendationInteractionRecordedEvent,
    categoryId?: string | null,
    brandId?: string | null,
  ): Promise<void> {
    const sessionId = event.data.sessionId;
    if (!sessionId) return;
    // Dùng compare-and-set theo version thay GET/SET nối tiếp để event đồng thời không ghi đè context của nhau.
    const key = this.key(sessionId);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const previous = (await this.get(sessionId)) ?? this.empty(sessionId);
      const now = new Date(event.occurredAt).getTime();
      if (new Date(previous.intentUpdatedAt).getTime() > now) return;
      const next: SessionContext = {
        ...previous,
        currentProductId: event.data.productId ?? previous.currentProductId,
        currentCategoryId:
          categoryId ?? event.data.categoryId ?? previous.currentCategoryId,
        latestQuery: event.data.query ?? previous.latestQuery,
        recentProductIds: this.unshift(
          event.data.productId,
          previous.recentProductIds,
        ),
        recentCategoryIds: this.unshift(
          categoryId ?? event.data.categoryId,
          previous.recentCategoryIds,
        ),
        recentBrandIds: this.unshift(brandId, previous.recentBrandIds),
        cartProductIds: this.updateCart(
          event.data.interactionType,
          event.data.productId,
          previous.cartProductIds,
        ),
        intentUpdatedAt: event.occurredAt,
        version: previous.version + 1,
      };
      if (
        await this.redis.compareAndSetJson(
          key,
          previous.version,
          next,
          SESSION_TTL_SECONDS,
        )
      )
        return;
    }
  }

  // Xóa session context sau merge hoặc khi session cần bắt đầu lại mà không ảnh hưởng profile durable.
  async invalidate(sessionId: string): Promise<void> {
    await this.redis.invalidate(this.key(sessionId));
  }

  // Tạo context mặc định để xử lý guest mới mà không cần khởi tạo record trước.
  private empty(sessionId: string): SessionContext {
    return {
      sessionId,
      recentProductIds: [],
      recentCategoryIds: [],
      recentBrandIds: [],
      currentProductId: null,
      currentCategoryId: null,
      latestQuery: null,
      cartProductIds: [],
      intentUpdatedAt: new Date(0).toISOString(),
      version: 0,
    };
  }

  // Đưa key lên đầu, loại duplicate và giới hạn kích thước để Redis không phình theo session dài.
  private unshift(
    value: string | null | undefined,
    values: string[],
  ): string[] {
    if (!value) return values;
    return [value, ...values.filter((item) => item !== value)].slice(
      0,
      MAX_RECENT_ITEMS,
    );
  }

  // Cart add/remove là context mạnh hơn view nên được giữ riêng để candidate tránh hoặc ưu tiên đúng sản phẩm.
  private updateCart(
    type: string,
    productId: string | null,
    values: string[],
  ): string[] {
    if (!productId) return values;
    if (type === "PRODUCT_ADDED_TO_CART")
      return this.unshift(productId, values);
    if (type === "PRODUCT_REMOVED_FROM_CART")
      return values.filter((item) => item !== productId);
    return values;
  }

  // Chuẩn hóa key Redis để các surface dùng cùng session context và invalidation không bị lệch namespace.
  private key(sessionId: string): string {
    return `recommendation:session:${sessionId}:context`;
  }
}
