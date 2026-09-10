import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, EntityManager, Repository } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { RecommendationInteractionEntity } from "../../../../database/interactions/entities/interaction.entity";
import { RecommendationProductRelationEntity } from "../../../../database/relations/entities/product-relation.entity";

export type RelationType = "CO_VIEW" | "CO_CART" | "CO_PURCHASE";

// Repository chứa SQL relation projection/query; policy weight và cửa sổ thời gian nằm ở application service.
@Injectable()
export class RelationRepository {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    @InjectRepository(RecommendationInteractionEntity)
    private readonly interactions: Repository<RecommendationInteractionEntity>,
    @InjectRepository(RecommendationProductRelationEntity)
    private readonly relations: Repository<RecommendationProductRelationEntity>,
  ) {}

  // Ghi ledger va relation trong cung transaction de loi giua chung van duoc Kafka redeliver an toan.
  async withProjection(
    eventId: string,
    projectionType: string,
    work: (manager: EntityManager) => Promise<void>,
  ): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const inserted = (await manager.query(
        `INSERT INTO recommendation_relation_projection_events (event_id, projection_type)
         VALUES ($1, $2)
         ON CONFLICT (event_id, projection_type) DO NOTHING
         RETURNING event_id`,
        [eventId, projectionType],
      )) as Array<{ event_id: string }>;
      if (inserted.length === 0) return false;
      await work(manager);
      return true;
    });
  }

  // Claim event projection atomically bằng unique ledger, tránh xử lý duplicate Kafka lần hai.
  // Lấy các product distinct trong cùng actor/window, có giới hạn để tránh pair explosion.
  async findRecentProductIds(
    input: {
      userId: string | null;
      sessionId: string | null;
      since: Date;
      until: Date;
      types: string[];
      limit: number;
    },
    manager?: EntityManager,
  ): Promise<string[]> {
    const repository = (manager ?? this.interactions.manager).getRepository(
      RecommendationInteractionEntity,
    );
    const query = repository
      .createQueryBuilder("interaction")
      .select("DISTINCT interaction.product_id", "productId")
      .where("interaction.product_id IS NOT NULL")
      .andWhere("interaction.occurred_at >= :since", { since: input.since })
      .andWhere("interaction.occurred_at <= :until", { until: input.until })
      .andWhere("interaction.interaction_type IN (:...types)", {
        types: input.types,
      });
    if (input.sessionId)
      query.andWhere("interaction.session_id = :sessionId", {
        sessionId: input.sessionId,
      });
    else if (input.userId)
      query.andWhere("interaction.user_id = :userId", { userId: input.userId });
    else return [];
    const rows = await query
      .select("interaction.product_id", "productId")
      .addSelect("MAX(interaction.occurred_at)", "lastOccurredAt")
      .groupBy("interaction.product_id")
      // Sắp xếp bằng biểu thức/cột gốc để PostgreSQL không hạ alias camelCase thành chữ thường.
      .orderBy("MAX(interaction.occurred_at)", "DESC")
      .addOrderBy("interaction.product_id", "ASC")
      .limit(Math.min(input.limit, 50))
      .getRawMany<{ productId: string }>();
    return rows.map((row) => row.productId).filter(Boolean);
  }

  // Cộng directed relation bằng UPSERT; score delta do rule policy truyền vào và không hard-code trong persistence.
  async addRelation(
    input: {
      sourceProductId: string;
      targetProductId: string;
      relationType: RelationType;
      positiveDelta: number;
      negativeDelta: number;
      scoreDelta: number;
      signalAt: Date;
      windowStart: Date;
      windowEnd: Date;
    },
    manager?: EntityManager,
  ): Promise<void> {
    await (manager ?? this.relations.manager).query(
      `
      INSERT INTO recommendation_product_relations (source_product_id, target_product_id, relation_type, positive_count, negative_count, relation_score, last_signal_at, window_start, window_end)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (source_product_id, target_product_id, relation_type) DO UPDATE SET
        positive_count = recommendation_product_relations.positive_count + $4,
        negative_count = recommendation_product_relations.negative_count + $5,
        relation_score = recommendation_product_relations.relation_score + $6,
        last_signal_at = GREATEST(recommendation_product_relations.last_signal_at, EXCLUDED.last_signal_at),
        window_start = LEAST(recommendation_product_relations.window_start, EXCLUDED.window_start),
        window_end = GREATEST(recommendation_product_relations.window_end, EXCLUDED.window_end),
        updated_at = now()
    `,
      [
        input.sourceProductId,
        input.targetProductId,
        input.relationType,
        input.positiveDelta,
        input.negativeDelta,
        input.scoreDelta,
        input.signalAt,
        input.windowStart,
        input.windowEnd,
      ],
    );
  }

  // Candidate query giữ top target bounded theo relation type và loại self relation.
  async findTargets(
    sourceProductIds: string[],
    types: RelationType[],
    limit: number,
  ): Promise<
    Array<{
      productId: string;
      rawScore: number;
      relationType: RelationType;
      anchorProductId: string;
    }>
  > {
    if (!sourceProductIds.length) return [];
    const configuredHalfLifeDays = Number(
      this.config.get<string>("RELATION_SCORE_HALF_LIFE_DAYS", "30"),
    );
    const halfLifeDays =
      Number.isFinite(configuredHalfLifeDays) && configuredHalfLifeDays > 0
        ? configuredHalfLifeDays
        : 30;
    const effectiveScore = `(relation.relation_score * power(0.5, extract(epoch from (now() - relation.last_signal_at)) / ${halfLifeDays * 86400}))`;
    const rows = (await this.relations.query(
      `WITH ranked AS (
         SELECT
           relation.target_product_id AS "productId",
           ${effectiveScore} AS "rawScore",
           relation.relation_type AS "relationType",
           relation.source_product_id AS "anchorProductId",
           ROW_NUMBER() OVER (
             PARTITION BY relation.source_product_id, relation.relation_type
             ORDER BY ${effectiveScore} DESC, relation.target_product_id ASC
           ) AS row_number
         FROM recommendation_product_relations relation
         WHERE relation.source_product_id = ANY($1)
           AND relation.relation_type = ANY($2)
           AND ${effectiveScore} > 0
       )
       SELECT "productId", "rawScore", "relationType", "anchorProductId"
       FROM ranked
       WHERE row_number <= $3
       ORDER BY "rawScore" DESC, "productId" ASC`,
      [sourceProductIds, types, Math.min(Math.max(limit, 1), 100)],
    )) as Array<{
      productId: string;
      rawScore: number | string;
      relationType: RelationType;
      anchorProductId: string;
    }>;
    return rows.map((row) => ({ ...row, rawScore: Number(row.rawScore) }));
  }

  // Giữ tối đa target mạnh nhất cho từng anchor/relation để bảng không phình vô hạn theo thời gian.
  async pruneSourceRelations(
    sourceProductId: string,
    relationType: RelationType,
    keep = 100,
    manager?: EntityManager,
  ): Promise<void> {
    await (manager ?? this.relations.manager).query(
      `DELETE FROM recommendation_product_relations relation
        WHERE relation.id IN (
          SELECT id FROM (
            SELECT id,
                   ROW_NUMBER() OVER (
                     ORDER BY (relation_score * power(0.5, extract(epoch from (now() - last_signal_at)) / ${this.halfLifeSeconds()})) DESC,
                              target_product_id ASC
                   ) AS row_number
            FROM recommendation_product_relations
            WHERE source_product_id = $1 AND relation_type = $2
          ) ranked
          WHERE ranked.row_number > $3
        )`,
      [sourceProductId, relationType, Math.min(Math.max(keep, 1), 100)],
    );
  }

  // Chuẩn hóa half-life trước khi chèn vào SQL động để decay/prune không tạo biểu thức sai hoặc chia cho 0.
  private halfLifeSeconds(): number {
    const configured = Number(
      this.config.get<string>("RELATION_SCORE_HALF_LIFE_DAYS", "30"),
    );
    const days =
      Number.isFinite(configured) && configured > 0 ? configured : 30;
    return days * 86_400;
  }
}
