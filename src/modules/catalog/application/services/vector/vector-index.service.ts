import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export interface SemanticSearchResult {
  productId: string;
  similarityScore: number;
  anchorProductId?: string;
  modelVersion: string;
}

// Port/adapter HTTP cho Qdrant, không kéo SDK vào business layer và có thể đổi sang managed adapter sau này.
@Injectable()
export class VectorIndexService implements OnModuleInit {
  private readonly logger = new Logger(VectorIndexService.name);
  private readonly baseUrl: string;
  private readonly alias: string;
  private readonly collectionVersion: string;
  private readonly dimensions: number;
  private readonly distance: "Cosine" | "Dot" | "Euclid";
  private readonly timeoutMs: number;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = config.get<string>("QDRANT_URL", "http://localhost:6333").replace(/\/$/, "");
    this.alias = config.get<string>("QDRANT_COLLECTION_ALIAS", "recommendation_product_embeddings_current");
    this.collectionVersion = config.get<string>("QDRANT_COLLECTION_VERSION", "1");
    const configuredDimensions = Number(config.get<string>("QDRANT_VECTOR_SIZE", "1536"));
    this.dimensions = Number.isInteger(configuredDimensions) && configuredDimensions > 0 ? configuredDimensions : 1536;
    const configuredDistance = config.get<string>("QDRANT_DISTANCE", "Cosine");
    this.distance = configuredDistance === "Dot" || configuredDistance === "Euclid" ? configuredDistance : "Cosine";
    const configuredTimeout = Number(config.get<string>("QDRANT_TIMEOUT_MS", "500"));
    this.timeoutMs = Number.isInteger(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 500;
  }

  // Khởi tạo alias/collection bất đồng bộ; Qdrant chưa sẵn sàng chỉ làm semantic source tạm thời rỗng.
  onModuleInit(): void {
    void this.ensureCollection();
  }

  // Tạo collection vật lý và alias idempotent khi service khởi động; thiếu Qdrant không làm process crash.
  async ensureCollection(): Promise<void> {
    const collection = `${this.alias}_v${this.collectionVersion}`;
    try {
      const exists = await this.request(`/collections/${collection}`);
      if (!exists.ok) {
        const created = await this.request(`/collections/${collection}`, {
          method: "PUT",
          body: JSON.stringify({ vectors: { size: this.dimensions, distance: this.distance } }),
        });
        if (!created.ok) throw new Error(`QDRANT_COLLECTION_CREATE_FAILED_${created.status}`);
      }
      const aliasesResponse = await this.request("/aliases");
      const aliasesBody = aliasesResponse.ok
        ? (await aliasesResponse.json()) as { result?: { aliases?: Array<{ alias_name?: string; collection_name?: string }> } }
        : { result: { aliases: [] } };
      const currentAlias = (aliasesBody.result?.aliases ?? []).find((item) => item.alias_name === this.alias);
      const collectionInfo = await this.request(`/collections/${collection}`);
      const collectionBody = collectionInfo.ok
        ? (await collectionInfo.json()) as { result?: { points_count?: number } }
        : { result: { points_count: 0 } };
      const indexedPoints = collectionBody.result?.points_count ?? 0;
      const action = currentAlias
        ? currentAlias.collection_name === collection
          ? null
          : indexedPoints > 0
            ? { change_alias: { collection_name: collection, alias_name: this.alias } }
            : null
        : { create_alias: { collection_name: collection, alias_name: this.alias } };
      if (currentAlias && currentAlias.collection_name !== collection && !action) {
        this.logger.warn(`Qdrant alias switch skipped because ${collection} is empty`);
      }
      if (action) {
        const aliasUpdate = await this.request(`/collections/aliases`, {
          method: "POST",
          body: JSON.stringify({ actions: [action] }),
        });
        if (!aliasUpdate.ok) throw new Error(`QDRANT_ALIAS_UPDATE_FAILED_${aliasUpdate.status}`);
      }
    } catch (error) {
      this.logger.warn(`Qdrant initialization deferred: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }

  // Upsert vector kèm payload filter; PostgreSQL vẫn là nguồn dữ liệu card/business state.
  async upsertProductVector(input: {
    productId: string;
    vector: number[];
    contentHash: string;
    modelVersion: string;
    catalogRevision: string;
    originType: string;
    categoryId: string | null;
    brandId: string | null;
    sellerShopId: string | null;
    externalShopId: string | null;
    minPrice: string;
    maxPrice: string;
    status: string;
    isInStock: boolean;
  }): Promise<void> {
    if (input.vector.length !== this.dimensions) throw new Error("EMBEDDING_DIMENSION_MISMATCH");
    const response = await this.request(`/collections/${this.alias}/points?wait=true`, {
      method: "PUT",
      body: JSON.stringify({ points: [{ id: input.productId, vector: input.vector, payload: { ...input, productId: input.productId } }] }),
    });
    if (!response.ok) throw new Error(`QDRANT_UPSERT_FAILED_${response.status}`);
  }

  // Search semantic candidates chỉ trả IDs/scores; card data vẫn được hydrate từ local catalog repository.
  async searchSimilarProducts(vector: number[], limit: number, excludeProductIds: string[] = []): Promise<SemanticSearchResult[]> {
    if (vector.length !== this.dimensions) return [];
    const response = await this.request(`/collections/${this.alias}/points/search`, {
      method: "POST",
      body: JSON.stringify({
        vector,
        limit: Math.min(Math.max(limit, 1), 60),
        with_payload: true,
        filter: { must: [{ key: "status", match: { value: "ACTIVE" } }, { key: "isInStock", match: { value: true } }] },
      }),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { result?: Array<{ id: string; score: number; payload?: { productId?: string; modelVersion?: string } }> };
    return (body.result ?? [])
      .map((item) => ({ productId: item.payload?.productId ?? item.id, similarityScore: item.score, modelVersion: item.payload?.modelVersion ?? "unknown" }))
      .filter((item) => !excludeProductIds.includes(item.productId));
  }

  // Lấy vector của anchor product để semantic source không gọi OpenAI trong request recommendation.
  async getProductVector(productId: string): Promise<number[] | null> {
    const response = await this.request(`/collections/${this.alias}/points/${encodeURIComponent(productId)}?with_vector=true`);
    if (!response.ok) return null;
    const body = (await response.json()) as { result?: { vector?: number[] } };
    return Array.isArray(body.result?.vector) ? body.result.vector : null;
  }

  // Cập nhật status/stock payload khi catalog động thay đổi mà không rebuild embedding.
  async updateProductPayload(productId: string, payload: Record<string, unknown>): Promise<void> {
    const response = await this.request(`/collections/${this.alias}/points/payload?wait=true`, {
      method: "POST",
      body: JSON.stringify({ points: [productId], payload }),
    });
    if (!response.ok) throw new Error(`QDRANT_PAYLOAD_UPDATE_FAILED_${response.status}`);
  }

  // Deactivate vector payload để semantic filter không trả product inactive/out-of-stock.
  async deactivateProduct(productId: string): Promise<void> {
    await this.updateProductPayload(productId, { status: "INACTIVE", isInStock: false });
  }

  // Xóa vector khi catalog đã deleted; status payload vẫn là fallback trước khi cleanup hoàn tất.
  async deleteProductVector(productId: string): Promise<void> {
    const response = await this.request(`/collections/${this.alias}/points/delete?wait=true`, { method: "POST", body: JSON.stringify({ points: [productId] }) });
    if (!response.ok) throw new Error(`QDRANT_DELETE_FAILED_${response.status}`);
  }

  // Health adapter dùng cho diagnostics, không được gọi trong recommendation request.
  async getHealth(): Promise<boolean> {
    try {
      return (await this.request("/healthz")).ok;
    } catch {
      return false;
    }
  }

  // Coverage chỉ lấy aggregate count để rollout biết bao nhiêu catalog đã sẵn sàng vector.
  async getCoverage(): Promise<{ indexed: number; collection: string } | null> {
    try {
      const response = await this.request(`/collections/${this.alias}`);
      if (!response.ok) return null;
      const body = (await response.json()) as { result?: { points_count?: number } };
      return { indexed: body.result?.points_count ?? 0, collection: this.alias };
    } catch {
      return null;
    }
  }

  // Request có timeout ngắn; caller phải fail-soft và dùng source Phase 2 nếu Qdrant unavailable.
  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(`${this.baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) }, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }
}
