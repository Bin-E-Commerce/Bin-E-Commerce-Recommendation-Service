// Client nội bộ đọc account projection từ Auth Service; không chứa business rule hoặc expose credential.

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export interface RecommendationAccountProfile {
  keycloakId: string;
  name: string;
  email: string;
  phone: string | null;
  avatarUrl: string | null;
}

interface RecommendationProfilesResponse {
  data?: RecommendationAccountProfile[];
}

@Injectable()
export class RecommendationAccountDirectoryClient {
  private readonly logger = new Logger(
    RecommendationAccountDirectoryClient.name,
  );
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(config: ConfigService) {
    this.baseUrl = config
      .get<string>("AUTH_SERVICE_URL", "http://localhost:3002")
      .replace(/\/$/, "");
    this.token = config.get<string>("INTERNAL_SERVICE_TOKEN", "");
  }

  // Batch lookup tối đa 100 account; lỗi Auth không làm hỏng aggregate recommendation, UI sẽ dùng fallback an toàn.
  async findProfiles(input: {
    ids?: string[];
    search?: string;
  }): Promise<RecommendationAccountProfile[]> {
    const params = new URLSearchParams();
    const ids = [...new Set((input.ids ?? []).filter(Boolean))].slice(0, 100);
    if (ids.length === 0 && !input.search?.trim()) return [];
    if (ids.length > 0) params.set("ids", ids.join(","));
    if (input.search?.trim()) params.set("search", input.search.trim());

    try {
      const response = await fetch(
        `${this.baseUrl}/api/v1/internal/users/recommendation-profiles?${params}`,
        {
          headers: { "x-internal-service-token": this.token },
          signal: AbortSignal.timeout(3000),
        },
      );
      if (!response.ok)
        throw new Error(`Auth Service returned ${response.status}`);
      const payload = (await response.json()) as RecommendationProfilesResponse;
      return Array.isArray(payload.data) ? payload.data : [];
    } catch (error) {
      this.logger.warn(
        `Account profile lookup unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      return [];
    }
  }
}
