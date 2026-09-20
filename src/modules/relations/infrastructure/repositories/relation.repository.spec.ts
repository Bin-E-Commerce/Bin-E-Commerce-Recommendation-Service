// Test persistence boundary của relation projection; bảo đảm batch trùng khóa được gộp trước khi PostgreSQL upsert.
import type { ConfigService } from "@nestjs/config";
import type { DataSource, EntityManager, Repository } from "typeorm";
import { RelationRepository } from "./relation.repository";
import type { RecommendationProductRelationEntity } from "../../../../database/relations/entities/product-relation.entity";
import type { RecommendationRelationSignalEntity } from "../../../../database/relations/entities/relation-signal.entity";

describe("RelationRepository", () => {
  it("coalesces duplicate directed pairs before the upsert statement", async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const repository = new RelationRepository(
      {} as DataSource,
      {} as ConfigService,
      {} as Repository<RecommendationRelationSignalEntity>,
      {} as Repository<RecommendationProductRelationEntity>,
    );
    const manager = { query } as unknown as EntityManager;
    const firstSignalAt = new Date("2026-09-19T10:00:00.000Z");
    const secondSignalAt = new Date("2026-09-19T10:01:00.000Z");
    const firstWindowStart = new Date("2026-09-19T09:30:00.000Z");
    const secondWindowStart = new Date("2026-09-19T09:31:00.000Z");
    const firstWindowEnd = new Date("2026-09-19T10:00:00.000Z");
    const secondWindowEnd = new Date("2026-09-19T10:01:00.000Z");

    await repository.addRelations(
      [
        {
          sourceProductId: "product-a",
          targetProductId: "product-b",
          relationType: "CO_VIEW",
          positiveDelta: 1,
          negativeDelta: 0,
          scoreDelta: 1,
          signalAt: firstSignalAt,
          windowStart: firstWindowStart,
          windowEnd: firstWindowEnd,
        },
        {
          sourceProductId: "product-a",
          targetProductId: "product-b",
          relationType: "CO_VIEW",
          positiveDelta: 1,
          negativeDelta: 1,
          scoreDelta: -0.25,
          signalAt: secondSignalAt,
          windowStart: secondWindowStart,
          windowEnd: secondWindowEnd,
        },
      ],
      manager,
    );

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toEqual([
      "product-a",
      "product-b",
      "CO_VIEW",
      2,
      1,
      0.75,
      secondSignalAt,
      firstWindowStart,
      secondWindowEnd,
    ]);
  });
});
