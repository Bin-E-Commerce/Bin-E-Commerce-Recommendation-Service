// Báo cáo chỉ đọc chất lượng snapshot và attribution; không xuất ID, tạo nhãn hoặc sửa dữ liệu.

import { DataSource } from 'typeorm';

const PILOT_AUDIT_QUERY = `
WITH production_snapshots AS (
    SELECT * FROM recommendation_training_snapshots
    WHERE environment = 'production' AND served_at >= $1::timestamptz
), snapshot_candidates AS (
    SELECT
        snapshot.request_id,
        snapshot.served_at,
        snapshot.feature_schema_version,
        candidate.value AS candidate
    FROM production_snapshots AS snapshot
    CROSS JOIN LATERAL jsonb_array_elements(snapshot.candidates) AS candidate(value)
), attributed_events AS (
    SELECT
        interaction_type,
        recommendation_request_id,
        recommendation_rank,
        product_id,
        occurred_at
    FROM recommendation_interactions
    WHERE recommendation_request_id IS NOT NULL
      AND interaction_type IN ('PRODUCT_IMPRESSED', 'PRODUCT_CLICKED')
      AND occurred_at >= $1::timestamptz
), joined_events AS (
    SELECT
        event.interaction_type,
        event.recommendation_request_id,
        event.recommendation_rank,
        event.product_id,
        event.occurred_at,
        candidate.request_id AS candidate_request_id,
        candidate.candidate->>'rank' AS candidate_rank,
        candidate.served_at
    FROM attributed_events AS event
    LEFT JOIN snapshot_candidates AS candidate
      ON candidate.request_id = event.recommendation_request_id
     AND candidate.candidate->>'productId' = event.product_id
     AND jsonb_typeof(candidate.candidate->'rank') = 'number'
), request_groups AS (
    SELECT
        recommendation_request_id,
        COUNT(DISTINCT product_id) FILTER (
            WHERE interaction_type = 'PRODUCT_IMPRESSED'
              AND candidate_request_id IS NOT NULL
        ) AS impressed_items,
        COUNT(DISTINCT product_id) FILTER (
            WHERE interaction_type = 'PRODUCT_CLICKED'
              AND candidate_request_id IS NOT NULL
        ) AS clicked_items
    FROM joined_events
    WHERE candidate_request_id IS NOT NULL
    GROUP BY recommendation_request_id
)
SELECT
    (SELECT COUNT(*) FROM production_snapshots) AS snapshot_requests,
    (SELECT COUNT(*) FROM recommendation_training_snapshots
      WHERE environment <> 'production'
        AND served_at >= $1::timestamptz) AS nonproduction_snapshot_requests,
    (SELECT COUNT(*) FROM production_snapshots
      WHERE feature_schema_version = 'ranking-features-v3') AS current_schema_requests,
    (SELECT COUNT(*) FROM snapshot_candidates) AS candidate_rows,
    (SELECT COUNT(*) FROM snapshot_candidates
      WHERE CASE
        WHEN jsonb_typeof(candidate->'features') = 'object' THEN
          (candidate->'features') ?& ARRAY[
            'profileAffinity', 'sessionContext', 'semanticSimilarity', 'coBehavior',
            'popularity', 'freshness', 'quality', 'exploration', 'negativePenalty'
          ]
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_each(candidate->'features') AS feature(key, value)
            WHERE feature.key = ANY(ARRAY[
              'profileAffinity', 'sessionContext', 'semanticSimilarity', 'coBehavior',
              'popularity', 'freshness', 'quality', 'exploration', 'negativePenalty'
            ])
              AND (
                jsonb_typeof(feature.value) <> 'number'
                OR (feature.value #>> '{}')::numeric NOT BETWEEN 0 AND 1
              )
          )
        ELSE FALSE
      END) AS feature_complete_candidate_rows,
    (SELECT COUNT(*) FROM snapshot_candidates
      WHERE jsonb_typeof(candidate->'score') = 'number') AS candidates_with_score,
    (SELECT COUNT(*) FROM snapshot_candidates
      WHERE jsonb_typeof(candidate->'rank') = 'number') AS candidates_selected_for_slate,
    (SELECT COUNT(*) FROM production_snapshots
      WHERE candidate_count > 0 AND ranking_model_version IS NULL) AS requests_without_model_version,
    (SELECT COUNT(*) FROM production_snapshots AS snapshot
      WHERE EXISTS (
        SELECT 1 FROM jsonb_array_elements(snapshot.source_candidates) AS source(value)
        WHERE source.value->>'truncated' = 'true'
      )) AS requests_with_truncated_source_lists,
    (SELECT COUNT(*) FROM production_snapshots
      WHERE features_computed_at > served_at) AS feature_timestamp_violations,
    (SELECT COUNT(*) FROM production_snapshots AS snapshot
      WHERE jsonb_array_length(snapshot.candidates) <> snapshot.candidate_count
        OR (
          SELECT COUNT(*) FROM jsonb_array_elements(snapshot.candidates) AS candidate(value)
          WHERE jsonb_typeof(candidate.value->'rank') = 'number'
        ) <> snapshot.selected_candidate_count) AS candidate_count_mismatch_requests,
    (SELECT COUNT(*) FROM attributed_events) AS attributed_impression_click_events,
    (SELECT COUNT(*) FROM joined_events
      WHERE interaction_type = 'PRODUCT_IMPRESSED'
        AND candidate_request_id IS NOT NULL) AS matched_impressions,
    (SELECT COUNT(*) FROM joined_events
      WHERE interaction_type = 'PRODUCT_CLICKED'
        AND candidate_request_id IS NOT NULL) AS matched_clicks,
    (SELECT COUNT(*) FROM joined_events AS click
      WHERE click.interaction_type = 'PRODUCT_CLICKED'
        AND click.candidate_request_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM joined_events AS impression
          WHERE impression.interaction_type = 'PRODUCT_IMPRESSED'
            AND impression.candidate_request_id IS NOT NULL
            AND impression.recommendation_request_id = click.recommendation_request_id
            AND impression.product_id = click.product_id
        )) AS clicks_without_matching_impression,
    (SELECT COUNT(*) FROM joined_events
      WHERE candidate_request_id IS NOT NULL
        AND recommendation_rank::text IS DISTINCT FROM candidate_rank) AS event_rank_mismatches,
    (SELECT COUNT(DISTINCT recommendation_request_id) FROM joined_events
      WHERE candidate_request_id IS NULL) AS request_ids_without_snapshot_match,
    (SELECT COUNT(*) FROM request_groups
      WHERE impressed_items >= 2 AND clicked_items >= 1) AS groups_with_two_or_more_impressions_and_a_click,
    (SELECT COUNT(*) FROM joined_events
      WHERE interaction_type = 'PRODUCT_CLICKED'
        AND candidate_request_id IS NOT NULL
        AND occurred_at < served_at) AS clicks_before_snapshot_time,
    (SELECT ROUND((PERCENTILE_CONT(0.50) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (occurred_at - served_at))
      ))::numeric, 2)
      FROM joined_events
      WHERE interaction_type = 'PRODUCT_CLICKED'
        AND candidate_request_id IS NOT NULL
        AND occurred_at >= served_at) AS click_ingestion_delay_p50_seconds,
    (SELECT ROUND((PERCENTILE_CONT(0.90) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (occurred_at - served_at))
      ))::numeric, 2)
      FROM joined_events
      WHERE interaction_type = 'PRODUCT_CLICKED'
        AND candidate_request_id IS NOT NULL
        AND occurred_at >= served_at) AS click_ingestion_delay_p90_seconds,
    (SELECT ROUND((PERCENTILE_CONT(0.95) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (occurred_at - served_at))
      ))::numeric, 2)
      FROM joined_events
      WHERE interaction_type = 'PRODUCT_CLICKED'
        AND candidate_request_id IS NOT NULL
        AND occurred_at >= served_at) AS click_ingestion_delay_p95_seconds
`;

interface PilotAuditRow {
    snapshot_requests: string;
    nonproduction_snapshot_requests: string;
    current_schema_requests: string;
    candidate_rows: string;
    feature_complete_candidate_rows: string;
    candidates_with_score: string;
    candidates_selected_for_slate: string;
    requests_without_model_version: string;
    requests_with_truncated_source_lists: string;
    feature_timestamp_violations: string;
    candidate_count_mismatch_requests: string;
    attributed_impression_click_events: string;
    matched_impressions: string;
    matched_clicks: string;
    clicks_without_matching_impression: string;
    event_rank_mismatches: string;
    request_ids_without_snapshot_match: string;
    groups_with_two_or_more_impressions_and_a_click: string;
    clicks_before_snapshot_time: string;
    click_ingestion_delay_p50_seconds: string | null;
    click_ingestion_delay_p90_seconds: string | null;
    click_ingestion_delay_p95_seconds: string | null;
}

// Kết nối bằng URL người vận hành cấp riêng, mở transaction read-only và chỉ trả số liệu tổng hợp.
async function auditPilot(): Promise<void> {
    const databaseUrl = process.env.RECOMMENDATION_PILOT_DATABASE_URL;
    if (!databaseUrl) {
        throw new Error('RECOMMENDATION_PILOT_DATABASE_URL_REQUIRED');
    }
    const configuredStartAt = process.env.RECOMMENDATION_PILOT_START_AT;
    const pilotStartAt = configuredStartAt ? new Date(configuredStartAt) : null;
    // Bắt buộc có timezone để mốc rollout không đổi theo máy đang chạy báo cáo.
    if (
        !configuredStartAt ||
        !/(?:Z|[+-]\d{2}:\d{2})$/i.test(configuredStartAt) ||
        !pilotStartAt ||
        !Number.isFinite(pilotStartAt.getTime())
    ) {
        throw new Error('RECOMMENDATION_PILOT_START_AT_REQUIRED');
    }

    const dataSource = new DataSource({
        type: 'postgres',
        url: databaseUrl,
        // Bật TLS và xác thực chứng chỉ mặc định để bảo vệ credential pilot.
        // Chỉ môi trường local mới được operator chọn rõ để dùng plaintext.
        ssl:
            process.env.POSTGRES_SSL === 'false'
                ? false
                : { rejectUnauthorized: true },
        extra: { max: 1 },
        synchronize: false,
        migrationsRun: false,
    });
    await dataSource.initialize();
    const runner = dataSource.createQueryRunner();

    try {
        await runner.connect();
        await runner.startTransaction('READ COMMITTED');
        await runner.query('SET TRANSACTION READ ONLY');
        const rows = (await runner.query(PILOT_AUDIT_QUERY, [
            pilotStartAt.toISOString(),
        ])) as PilotAuditRow[];
        const row = rows[0];
        if (!row) throw new Error('PILOT_AUDIT_RESULT_MISSING');

        const attributedEvents = Number(row.attributed_impression_click_events);
        const matchedEvents =
            Number(row.matched_impressions) + Number(row.matched_clicks);
        const report = {
            generatedAt: new Date().toISOString(),
            pilotStartAt: pilotStartAt.toISOString(),
            snapshots: {
                requests: Number(row.snapshot_requests),
                nonproductionRequests: Number(
                    row.nonproduction_snapshot_requests,
                ),
                currentFeatureSchemaRequests: Number(
                    row.current_schema_requests,
                ),
                candidates: Number(row.candidate_rows),
                candidatesWithAllNineFeatures: Number(
                    row.feature_complete_candidate_rows,
                ),
                candidatesWithScore: Number(row.candidates_with_score),
                candidatesSelectedForSlate: Number(
                    row.candidates_selected_for_slate,
                ),
                requestsWithoutModelVersion: Number(
                    row.requests_without_model_version,
                ),
                requestsWithTruncatedSourceLists: Number(
                    row.requests_with_truncated_source_lists,
                ),
                featureTimestampViolations: Number(
                    row.feature_timestamp_violations,
                ),
                candidateCountMismatchRequests: Number(
                    row.candidate_count_mismatch_requests,
                ),
                featureCompletenessPercent:
                    Number(row.candidate_rows) === 0
                        ? null
                        : Number(
                              (
                                  (Number(row.feature_complete_candidate_rows) /
                                      Number(row.candidate_rows)) *
                                  100
                              ).toFixed(2),
                          ),
            },
            attribution: {
                impressionAndClickEvents: attributedEvents,
                matchedImpressions: Number(row.matched_impressions),
                matchedClicks: Number(row.matched_clicks),
                clicksWithoutMatchingImpression: Number(
                    row.clicks_without_matching_impression,
                ),
                eventRankMismatches: Number(row.event_rank_mismatches),
                matchedEventPercent:
                    attributedEvents === 0
                        ? null
                        : Number(
                              (
                                  (matchedEvents / attributedEvents) *
                                  100
                              ).toFixed(2),
                          ),
                requestIdsWithoutSnapshotMatch: Number(
                    row.request_ids_without_snapshot_match,
                ),
                clicksBeforeSnapshotTime: Number(
                    row.clicks_before_snapshot_time,
                ),
            },
            potentialRankingGroups: Number(
                row.groups_with_two_or_more_impressions_and_a_click,
            ),
            observedClickIngestionDelaySeconds: {
                p50: row.click_ingestion_delay_p50_seconds,
                p90: row.click_ingestion_delay_p90_seconds,
                p95: row.click_ingestion_delay_p95_seconds,
            },
            labelGeneration:
                'not performed; attribution window remains unselected',
        };

        console.log(JSON.stringify(report, null, 2));
        await runner.commitTransaction();
    } catch {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
        throw new Error('RECOMMENDATION_PILOT_AUDIT_FAILED');
    } finally {
        await runner.release();
        await dataSource.destroy();
    }
}

// Trả mã lỗi tổng quát để console không lộ URL kết nối hoặc dữ liệu truy vấn.
void auditPilot().catch(() => {
    console.error(
        'Pilot audit failed. Check the read-only database URL, schema migration, and service logs.',
    );
    process.exitCode = 1;
});
