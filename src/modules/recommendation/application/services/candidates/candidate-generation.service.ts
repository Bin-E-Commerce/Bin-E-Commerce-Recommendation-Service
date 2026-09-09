import { Injectable, Logger } from "@nestjs/common";
import { CatalogService } from "../../../../catalog/application/services/catalog/catalog.service";
import type { RecommendationCatalogProduct } from "../../../../catalog/application/types/catalog-product.type";
import { RelationCandidateService } from "../../../../relations/application/services/candidates/relation-candidate.service";
import { SemanticCandidateService } from "./semantic-candidate.service";
import type {
  CandidateSourceInput,
  CandidateSourceResult,
} from "./candidate-source";

// Dieu phoi cac candidate source doc lap; loi mot source khong duoc lam hong recommendation pipeline.
@Injectable()
export class CandidateGenerationService {
  private readonly logger = new Logger(CandidateGenerationService.name);

  constructor(
    private readonly catalog: CatalogService,
    private readonly semantic: SemanticCandidateService,
    private readonly relations: RelationCandidateService,
  ) {}

  // Chay song song source catalog/semantic/behavior va giu lai ket qua cua source thanh cong.
  async generate(
    input: CandidateSourceInput,
  ): Promise<CandidateSourceResult[]> {
    const tasks: Array<{
      source: string;
      run: () => Promise<CandidateSourceResult>;
    }> = [
      {
        source: "PRODUCT_AFFINITY",
        run: () =>
          this.fromCatalog(
            "PRODUCT_AFFINITY",
            "MATCHED_PRODUCT_PREFERENCE",
            () => this.catalog.findByIds(input.profileProductIds),
          ),
      },
      {
        source: "CATEGORY_AFFINITY",
        run: () =>
          this.fromCatalog("CATEGORY_AFFINITY", "MATCHED_CATEGORY", () =>
            input.categoryIds.length
              ? this.catalog.findAvailable({
                  categoryIds: input.categoryIds,
                  excludeProductIds: input.excludedProductIds,
                  limit: 100,
                })
              : Promise.resolve([]),
          ),
      },
      {
        source: "BRAND_AFFINITY",
        run: () =>
          this.fromCatalog("BRAND_AFFINITY", "MATCHED_BRAND", () =>
            input.brandIds.length
              ? this.catalog.findAvailable({
                  brandIds: input.brandIds,
                  excludeProductIds: input.excludedProductIds,
                  limit: 80,
                })
              : Promise.resolve([]),
          ),
      },
      {
        source: "BEST_SELLING",
        run: () =>
          this.fromCatalog("BEST_SELLING", "BEST_SELLING", () =>
            this.catalog.findBestSelling(80, input.excludedProductIds),
          ),
      },
      {
        source: "TRENDING",
        run: () =>
          this.fromCatalog("TRENDING", "TRENDING", () =>
            this.catalog.findTrending(80, input.excludedProductIds),
          ),
      },
      {
        source: "NEWEST",
        run: () =>
          this.fromCatalog("NEWEST", "NEWEST", () =>
            this.catalog.findNewest(80, input.excludedProductIds),
          ),
      },
      {
        source: "EXPLORE",
        run: () =>
          this.fromCatalog("EXPLORE", "EXPLORE", () =>
            this.catalog.findExplore(60, input.excludedProductIds),
          ),
      },
      { source: "SEMANTIC_SIMILARITY", run: () => this.fromSemantic(input) },
      { source: "CO_BEHAVIOR", run: () => this.fromRelations(input) },
    ];
    const settled = await Promise.allSettled(tasks.map((task) => task.run()));
    return settled.flatMap((result, index) => {
      if (result.status === "fulfilled") return [result.value];
      const task = tasks[index];
      if (task)
        this.logger.warn(
          `Candidate source ${task.source} unavailable: ${this.errorMessage(result.reason)}`,
        );
      return [];
    });
  }

  // Gan reason/raw score thong nhat cho source dua tren catalog read model.
  private async fromCatalog(
    source: string,
    reasonCode: string,
    load: () => Promise<RecommendationCatalogProduct[]>,
  ): Promise<CandidateSourceResult> {
    const products = await load();
    return {
      source,
      products,
      contributionByProductId: this.contributions(products, reasonCode),
    };
  }

  // Hydrate semantic IDs tu PostgreSQL read model; request khong goi AI provider.
  private async fromSemantic(
    input: CandidateSourceInput,
  ): Promise<CandidateSourceResult> {
    const candidates = await this.semantic.findCandidates({
      productId: input.productId,
      recentProductIds: input.recentProductIds,
      profileProductIds: input.profileProductIds,
      excludeProductIds: input.excludedProductIds,
      limit: 60,
    });
    const byId = new Map(
      candidates.map((candidate) => [candidate.productId, candidate]),
    );
    const products = await this.catalog.findByIds(
      candidates.map((candidate) => candidate.productId),
    );
    return {
      source: "SEMANTIC_SIMILARITY",
      products,
      contributionByProductId: new Map(
        products.map((product) => {
          const candidate = byId.get(product.productId);
          return [
            product.productId,
            {
              rawScore: candidate?.rawScore ?? 0,
              reasonCode: "SEMANTICALLY_RELATED",
              anchorProductId: candidate?.anchorProductId,
              modelVersion: candidate?.modelVersion,
            },
          ];
        }),
      ),
    };
  }

  // Hydrate relation IDs tu catalog local va giu anchor product cho explainability/debug.
  private async fromRelations(
    input: CandidateSourceInput,
  ): Promise<CandidateSourceResult> {
    const anchors = [
      ...new Set([...input.profileProductIds, ...input.recentProductIds]),
    ].slice(0, 10);
    const candidates = await this.relations.findCandidates(
      anchors,
      input.excludedProductIds,
      100,
    );
    const byId = new Map(
      candidates.map((candidate) => [candidate.productId, candidate]),
    );
    const products = await this.catalog.findByIds(
      candidates.map((candidate) => candidate.productId),
    );
    return {
      source: "CO_BEHAVIOR",
      products,
      contributionByProductId: new Map(
        products.map((product) => {
          const candidate = byId.get(product.productId);
          return [
            product.productId,
            {
              rawScore: candidate?.rawScore ?? 0,
              reasonCode: "CO_BEHAVIOR_RELATED",
              anchorProductId: candidate?.anchorProductId,
            },
          ];
        }),
      ),
    };
  }

  private contributions(
    products: RecommendationCatalogProduct[],
    reasonCode: string,
  ): Map<string, { rawScore: number; reasonCode: string }> {
    return new Map(
      products.map((product) => [
        product.productId,
        { rawScore: 1, reasonCode },
      ]),
    );
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "unknown error";
  }
}
