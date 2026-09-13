// Repository này sở hữu transaction, advisory lock và SQL dọn dữ liệu; application chỉ truyền chính sách retention đã validate.

import { Injectable } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";

export interface RetentionRunInput {
  rawDays: number;
  aggregateDays: number;
  embeddingJobDays: number;
  replayJobDays: number;
  batchSize: number;
}

@Injectable()
export class RetentionRepository {
  constructor(private readonly dataSource: DataSource) {}

  // Chạy toàn bộ cleanup trên một connection để pg_try_advisory_xact_lock thực sự bảo vệ job giữa nhiều replica.
  async run(input: RetentionRunInput): Promise<boolean> {
    if (!this.dataSource.isInitialized) return false;

    // Mỗi batch giữ advisory xact lock ngắn, tránh transaction cleanup kéo dài và block projection.
    let ranCleanup = false;
    while (true) {
      const batch = await this.runLocked((manager) =>
        this.deleteInteractionBatch(manager, input.rawDays, input.batchSize),
      );
      if (!batch.acquired) return ranCleanup;
      ranCleanup = true;
      if ((batch.value ?? 0) < input.batchSize) break;
    }

    const cleanupQueries: Array<{ sql: string; parameters: unknown[] }> = [
      {
        sql:
          "DELETE FROM recommendation_product_popularity_daily " +
          "WHERE bucket_date < CURRENT_DATE - ($1::int * INTERVAL '1 day')",
        parameters: [input.aggregateDays],
      },
      {
        sql:
          "DELETE FROM recommendation_embedding_jobs " +
          "WHERE status IN ('COMPLETED', 'FAILED', 'SUPERSEDED') " +
          "AND updated_at < NOW() - ($1::int * INTERVAL '1 day') " +
          "AND NOT EXISTS (" +
          "  SELECT 1 FROM recommendation_catalog_products product " +
          "  WHERE product.product_id = recommendation_embedding_jobs.product_id " +
          "    AND product.content_hash = recommendation_embedding_jobs.content_hash " +
          "    AND product.embedding_model_version = recommendation_embedding_jobs.model_version " +
          "    AND product.embedding_status = 'READY'" +
          ")",
        parameters: [input.embeddingJobDays],
      },
      {
        sql:
          "DELETE FROM recommendation_replay_jobs " +
          "WHERE status IN ('COMPLETED', 'FAILED') " +
          "AND updated_at < NOW() - ($1::int * INTERVAL '1 day')",
        parameters: [input.replayJobDays],
      },
      {
        sql:
          "DELETE FROM recommendation_relation_pair_events " +
          "WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')",
        parameters: [input.rawDays],
      },
    ];
    for (const query of cleanupQueries) {
      const result = await this.runLocked((manager) =>
        manager.query(query.sql, query.parameters).then(() => undefined),
      );
      if (!result.acquired) return ranCleanup;
      ranCleanup = true;
    }
    return ranCleanup;
  }

  // Thực thi một tác vụ trong transaction có lock; lock xact tránh lỗi acquire ở connection này nhưng release ở connection khác.
  private async runLocked<T>(
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<{ acquired: boolean; value: T | null }> {
    return this.dataSource.transaction(async (manager) => {
      const lockResult = (await manager.query(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired",
        ["recommendation-retention"],
      )) as Array<{ acquired: boolean }>;
      if (lockResult[0]?.acquired !== true)
        return { acquired: false, value: null };
      return { acquired: true, value: await work(manager) };
    });
  }

  // Xóa một batch theo ctid để mỗi transaction ngắn và giảm lock contention với profile/relation projector.
  private async deleteInteractionBatch(
    manager: EntityManager,
    days: number,
    batchSize: number,
  ): Promise<number> {
    const rows = (await manager.query(
      "WITH expired AS (" +
        " SELECT ctid FROM recommendation_interactions" +
        " WHERE occurred_at < NOW() - ($1::int * INTERVAL '1 day')" +
        " ORDER BY occurred_at ASC LIMIT $2" +
        ") DELETE FROM recommendation_interactions interaction" +
        " USING expired WHERE interaction.ctid = expired.ctid" +
        " RETURNING interaction.event_id",
      [days, batchSize],
    )) as Array<{ event_id: string }>;
    const signalRows = (await manager.query(
      "WITH expired AS (" +
        " SELECT ctid FROM recommendation_relation_signals" +
        " WHERE occurred_at < NOW() - ($1::int * INTERVAL '1 day')" +
        " ORDER BY occurred_at ASC LIMIT $2" +
        ") DELETE FROM recommendation_relation_signals signal" +
        " USING expired WHERE signal.ctid = expired.ctid" +
        " RETURNING signal.event_id",
      [days, batchSize],
    )) as Array<{ event_id: string }>;
    return Math.max(rows.length, signalRows.length);
  }
}
