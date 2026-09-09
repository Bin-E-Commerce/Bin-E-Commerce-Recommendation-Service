// Module này sở hữu Redis client của Recommendation; Redis chỉ là cache/context và không phải nguồn sự thật của profile.

import {
  Global,
  Inject,
  Injectable,
  Module,
  OnModuleDestroy,
} from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import Redis from "ioredis";

export const RECOMMENDATION_REDIS = "RECOMMENDATION_REDIS";

// Provider tạo kết nối lazy để Recommendation vẫn khởi động và dùng PostgreSQL fallback khi Redis local chưa chạy.
@Injectable()
export class RecommendationRedisService implements OnModuleDestroy {
  constructor(@Inject(RECOMMENDATION_REDIS) private readonly redis: Redis) {}

  // Đọc JSON đã cache và trả null cho cache miss hoặc payload hỏng để caller tự fallback an toàn.
  async getJson<T>(key: string): Promise<T | null> {
    try {
      const value = await this.redis.get(key);
      if (!value) return null;
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  // Ghi JSON với TTL; lỗi Redis chỉ được nuốt ở adapter để không làm hỏng request recommendation.
  async setJson(
    key: string,
    value: unknown,
    ttlSeconds: number,
  ): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
    } catch {}
  }

  // Đọc version namespace; khi Redis lỗi trả 0 để request vẫn dùng được cache key mặc định và fallback durable state.
  async getVersion(key: string): Promise<number> {
    try {
      const value = await this.redis.get(key);
      const version = Number(value ?? 0);
      return Number.isSafeInteger(version) && version >= 0 ? version : 0;
    } catch {
      return 0;
    }
  }

  // Tăng version namespace thay cho SCAN/DEL toàn bộ cache, giúp invalidation có độ phức tạp O(1) và không chặn Redis.
  async bumpVersion(key: string): Promise<void> {
    try {
      await this.redis.incr(key);
    } catch {
      // Cache cũ vẫn tự hết hạn; PostgreSQL tiếp tục là nguồn dữ liệu chính khi Redis không khả dụng.
    }
  }

  // Ghi JSON chỉ khi version hiện tại còn khớp để nhiều Kafka event cùng session không ghi đè context của nhau.
  // Lua script gộp đọc version và SET thành một thao tác atomic; Redis lỗi trả false để projection durable vẫn tiếp tục.
  async compareAndSetJson(
    key: string,
    expectedVersion: number,
    value: unknown,
    ttlSeconds: number,
  ): Promise<boolean> {
    try {
      const result = await this.redis.eval(
        `
          local raw = redis.call("GET", KEYS[1])
          local currentVersion = 0
          if raw then
            local ok, decoded = pcall(cjson.decode, raw)
            if ok and decoded then
              currentVersion = tonumber(decoded.version or 0) or 0
            end
          end
          if currentVersion ~= tonumber(ARGV[1]) then
            return 0
          end
          redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3])
          return 1
        `,
        1,
        key,
        expectedVersion,
        JSON.stringify(value),
        ttlSeconds,
      );
      return Number(result) === 1;
    } catch {
      return false;
    }
  }

  // Xóa một hoặc nhiều key liên quan đến actor/product sau strong signal hoặc catalog thay đổi.
  async invalidate(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await this.redis.del(...keys);
    } catch {
      // Invalidation thất bại chỉ làm cache cũ sống đến TTL, không làm mất dữ liệu durable.
    }
  }

  // Xóa toàn bộ recommendation cache của một actor bằng scan có cursor để không dùng lệnh KEYS trên production.
  async invalidateActor(
    actorType: "user" | "session",
    actorId: string,
  ): Promise<void> {
    await this.bumpVersion(
      `recommendation:cache-version:${actorType}:${actorId}`,
    );
  }

  // Xóa toàn bộ recommendation result khi catalog hoặc profile thay đổi để page kế tiếp không phục vụ snapshot cũ.
  async invalidateRecommendations(): Promise<void> {
    await this.bumpVersion("recommendation:cache-version:global");
  }

  // Đóng client khi Nest shutdown để watch mode không giữ socket Redis cũ.
  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => void 0);
  }
}

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: RECOMMENDATION_REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Redis({
          host: config.get<string>("REDIS_HOST", "localhost"),
          port: Number(config.get<string>("REDIS_PORT", "6379")),
          password: config.get<string>("REDIS_PASSWORD") || undefined,
          db: Number(config.get<string>("REDIS_DB", "1")),
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
        }),
    },
    RecommendationRedisService,
  ],
  exports: [RECOMMENDATION_REDIS, RecommendationRedisService],
})
export class RecommendationRedisModule {}
