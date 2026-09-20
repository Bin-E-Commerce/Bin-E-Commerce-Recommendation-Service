import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, EntityManager, Repository } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { RecommendationProductRelationEntity } from "../../../../database/relations/entities/product-relation.entity";
import { RecommendationRelationSignalEntity } from "../../../../database/relations/entities/relation-signal.entity";

export type RelationType = "CO_VIEW" | "CO_CART" | "CO_PURCHASE";

// Repository chứa SQL relation projection/query; policy weight và cửa sổ thời gian nằm ở application service.
@Injectable()
export class RelationRepository {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    @InjectRepository(RecommendationRelationSignalEntity)
    private readonly signals: Repository<RecommendationRelationSignalEntity>,
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

  // Lưu signal trong relation-owned read model trước khi tạo pair; không phụ thuộc interaction projector khác group.
  async insertSignal(
    input: {
      eventId: string;
      userId: string | null;
      sessionId: string | null;
      interactionType: string;
      productId: string;
      occurredAt: Date;
    },
    manager: EntityManager,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO recommendation_relation_signals
        (event_id, user_id, session_id, interaction_type, product_id, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        input.eventId,
        input.userId,
        input.sessionId,
        input.interactionType,
        input.productId,
        input.occurredAt,
      ],
    );
  }

  // Lấy event thay vì chỉ product ID để pair-ledger có thể chống cộng trùng khi hai event đến lệch thứ tự.
  async findRecentSignals(
    input: {
      userId: string | null;
      sessionId: string | null;
      relationType: RelationType;
      since: Date;
      until: Date;
      types: string[];
      limit: number;
    },
    manager?: EntityManager,
  ): Promise<Array<{ eventId: string; productId: string; occurredAt: Date }>> {
    if (!input.types.length) return [];
    const repository = (manager ?? this.signals.manager).getRepository(
      RecommendationRelationSignalEntity,
    );
    const query = repository
      .createQueryBuilder("signal")
      .select("signal.event_id", "eventId")
      .addSelect("signal.product_id", "productId")
      .addSelect("signal.occurred_at", "occurredAt")
      .where("signal.occurred_at >= :since", { since: input.since })
      .andWhere("signal.occurred_at <= :until", { until: input.until })
      .andWhere("signal.interaction_type IN (:...types)", {
        types: input.types,
      });
    const scopes: string[] = [];
    if (input.relationType === "CO_VIEW") {
      if (!input.sessionId) return [];
      scopes.push("signal.session_id = :sessionId");
    } else {
      if (input.sessionId) scopes.push("signal.session_id = :sessionId");
      if (input.userId) scopes.push("signal.user_id = :userId");
      if (scopes.length === 0) return [];
    }
    query.andWhere(`(${scopes.join(" OR ")})`, {
      sessionId: input.sessionId,
      userId: input.userId,
    });
    const rows = await query
      .orderBy("signal.occurred_at", "ASC")
      .addOrderBy("signal.event_id", "ASC")
      .limit(this.normalizeLimit(input.limit, 50))
      .getRawMany<{
        eventId: string;
        productId: string;
        occurredAt: Date;
      }>();
    return rows.filter((row) => row.eventId && row.productId);
  }

  // Claim một cặp event trong transaction; chỉ caller claim thành công mới được cộng relation score.
  async claimPair(
    firstEventId: string,
    secondEventId: string,
    relationType: RelationType,
    manager: EntityManager,
  ): Promise<boolean> {
    if (firstEventId === secondEventId) return false;
    const [first, second] = [firstEventId, secondEventId].sort();
    const inserted = (await manager.query(
      `INSERT INTO recommendation_relation_pair_events
        (first_event_id, second_event_id, relation_type)
       VALUES ($1, $2, $3)
       ON CONFLICT (first_event_id, second_event_id, relation_type) DO NOTHING
       RETURNING first_event_id`,
      [first, second, relationType],
    )) as Array<{ first_event_id: string }>;
    return inserted.length > 0;
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
    await this.addRelations([input], manager);
  }

  // Ghi nhiều pair trong một statement để order lớn không biến thành hàng nghìn
  // round-trip PostgreSQL; caller vẫn dùng cùng transaction/ledger như trước.
  async addRelations(
    inputs: Array<{
      sourceProductId: string;
      targetProductId: string;
      relationType: RelationType;
      positiveDelta: number;
      negativeDelta: number;
      scoreDelta: number;
      signalAt: Date;
      windowStart: Date;
      windowEnd: Date;
    }>,
    manager?: EntityManager,
  ): Promise<void> {
    if (inputs.length === 0) return;
    // Nhiều event khác nhau có thể cùng tạo một directed product pair trong một batch.
    // PostgreSQL không cho một INSERT ... ON CONFLICT cập nhật cùng row hai lần, nên phải cộng delta trước.
    const aggregated = new Map<string, (typeof inputs)[number]>();
    for (const input of inputs) {
      const key = `${input.sourceProductId}\u0000${input.targetProductId}\u0000${input.relationType}`;
      const current = aggregated.get(key);
      if (!current) {
        aggregated.set(key, { ...input });
        continue;
      }

      current.positiveDelta += input.positiveDelta;
      current.negativeDelta += input.negativeDelta;
      current.scoreDelta += input.scoreDelta;
      if (input.signalAt > current.signalAt) current.signalAt = input.signalAt;
      if (input.windowStart < current.windowStart) {
        current.windowStart = input.windowStart;
      }
      if (input.windowEnd > current.windowEnd) {
        current.windowEnd = input.windowEnd;
      }
    }

    const values: string[] = [];
    const parameters: Array<string | number | Date> = [];
    for (const [index, input] of [...aggregated.values()].entries()) {
      const offset = index * 9;
      values.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9})`,
      );
      parameters.push(
        input.sourceProductId,
        input.targetProductId,
        input.relationType,
        input.positiveDelta,
        input.negativeDelta,
        input.scoreDelta,
        input.signalAt,
        input.windowStart,
        input.windowEnd,
      );
    }

    await (manager ?? this.relations.manager).query(
      `
      INSERT INTO recommendation_product_relations
        (source_product_id, target_product_id, relation_type, positive_count, negative_count, relation_score, last_signal_at, window_start, window_end)
      VALUES ${values.join(",")}
      ON CONFLICT (source_product_id, target_product_id, relation_type) DO UPDATE SET
        positive_count = recommendation_product_relations.positive_count + EXCLUDED.positive_count,
        negative_count = recommendation_product_relations.negative_count + EXCLUDED.negative_count,
        relation_score = recommendation_product_relations.relation_score + EXCLUDED.relation_score,
        last_signal_at = GREATEST(recommendation_product_relations.last_signal_at, EXCLUDED.last_signal_at),
        window_start = LEAST(recommendation_product_relations.window_start, EXCLUDED.window_start),
        window_end = GREATEST(recommendation_product_relations.window_end, EXCLUDED.window_end),
        updated_at = now()
      `,
      parameters,
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
         WHERE relation.source_product_id = ANY($1::varchar[])
           AND relation.relation_type = ANY($2::varchar[])
           AND ${effectiveScore} > 0
       )
       SELECT "productId", "rawScore", "relationType", "anchorProductId"
       FROM ranked
       WHERE row_number <= $3
       ORDER BY "rawScore" DESC, "productId" ASC
       LIMIT $4`,
      [
        [...new Set(sourceProductIds)],
        types,
        100,
        this.normalizeLimit(limit, 100),
      ],
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
    await this.pruneSourceRelationsBatch(
      [sourceProductId],
      relationType,
      keep,
      manager,
    );
  }

  // Prune nhiều anchor trong một query để purchase/co-view projection không tạo
  // thêm một round-trip cho từng source product.
  async pruneSourceRelationsBatch(
    sourceProductIds: string[],
    relationType: RelationType,
    keep = 100,
    manager?: EntityManager,
  ): Promise<void> {
    if (sourceProductIds.length === 0) return;
    await (manager ?? this.relations.manager).query(
      `DELETE FROM recommendation_product_relations relation
        WHERE relation.id IN (
          SELECT id FROM (
            SELECT id,
                   ROW_NUMBER() OVER (
                     PARTITION BY source_product_id
                     ORDER BY (relation_score * power(0.5, extract(epoch from (now() - last_signal_at)) / ${this.halfLifeSeconds()})) DESC,
                              target_product_id ASC
                   ) AS row_number
            FROM recommendation_product_relations
            WHERE source_product_id = ANY($1::varchar[]) AND relation_type = $2::varchar
          ) ranked
          WHERE ranked.row_number > $3
        )`,
      [
        [...new Set(sourceProductIds)],
        relationType,
        this.normalizeLimit(keep, 100),
      ],
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

  // Clamp limit tai persistence boundary de input loi khong tao SQL LIMIT NaN/Infinity.
  private normalizeLimit(value: number, maximum: number): number {
    return Number.isFinite(value)
      ? Math.min(Math.max(Math.trunc(value), 1), maximum)
      : maximum;
  }
}
