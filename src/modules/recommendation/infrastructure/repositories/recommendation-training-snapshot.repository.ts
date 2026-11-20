// Repository này ghi một snapshot recommendation bất biến; unique request ID giúp retry không nhân đôi query group.

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { RecommendationTrainingSnapshotEntity } from '@/database/recommendations/entities/recommendation-training-snapshot.entity';
import type {
    RecommendationTrainingSnapshotCopy,
    RecommendationTrainingSnapshot,
    RecommendationTrainingSnapshotWriter,
} from '@/modules/recommendation/application/types/recommendation-training-snapshot.types';
import { Repository } from 'typeorm';

@Injectable()
// Adapter lưu payload snapshot và tạo bản sao nhẹ cho mỗi lần phục vụ response từ cache.
export class RecommendationTrainingSnapshotRepository implements RecommendationTrainingSnapshotWriter {
    constructor(
        @InjectRepository(RecommendationTrainingSnapshotEntity)
        private readonly repository: Repository<RecommendationTrainingSnapshotEntity>,
    ) {}

    // Chuyển timestamp ISO sang Date tại adapter rồi insert idempotent để không ghi đè snapshot cũ cùng request ID.
    async save(snapshot: RecommendationTrainingSnapshot): Promise<void> {
        await this.repository.manager.query(
            `INSERT INTO "recommendation_training_snapshots" (
                "request_id", "served_at", "features_computed_at", "environment",
                "surface", "page", "strategy", "ranking_mode", "ranking_model_version",
                "ranking_policy_version", "feature_schema_version", "candidate_budget",
                "candidate_count", "selected_candidate_count", "source_candidates", "candidates"
             ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                $15::jsonb, $16::jsonb
             ) ON CONFLICT ("request_id") DO NOTHING`,
            [
                snapshot.requestId,
                new Date(snapshot.servedAt),
                new Date(snapshot.featuresComputedAt),
                snapshot.environment,
                snapshot.surface,
                snapshot.page,
                snapshot.strategy,
                snapshot.rankingMode,
                snapshot.rankingModelVersion,
                snapshot.rankingPolicyVersion,
                snapshot.featureSchemaVersion,
                snapshot.candidateBudget,
                snapshot.candidateCount,
                snapshot.selectedCandidateCount,
                JSON.stringify(snapshot.sourceCandidates),
                JSON.stringify(snapshot.candidates),
            ],
        );
    }

    // Tạo request row mới từ snapshot gốc khi Redis cache tái sử dụng slate, giữ nguyên feature lúc chấm và đổi mốc serving.
    async copyForServedRequest(
        copy: RecommendationTrainingSnapshotCopy,
    ): Promise<boolean> {
        const rows = (await this.repository.manager.query(
            `INSERT INTO "recommendation_training_snapshots" (
                "request_id", "served_at", "features_computed_at", "environment",
                "surface", "page", "strategy", "ranking_mode", "ranking_model_version",
                "ranking_policy_version", "feature_schema_version", "candidate_budget",
                "candidate_count", "selected_candidate_count", "source_candidates", "candidates"
             )
             SELECT $2, $3, "features_computed_at", "environment", "surface", "page",
                    "strategy", "ranking_mode", "ranking_model_version", "ranking_policy_version",
                    "feature_schema_version", "candidate_budget", "candidate_count",
                    "selected_candidate_count", "source_candidates", "candidates"
             FROM "recommendation_training_snapshots"
             WHERE "request_id" = $1
             ON CONFLICT ("request_id") DO NOTHING
             RETURNING "request_id"`,
            [copy.sourceRequestId, copy.requestId, new Date(copy.servedAt)],
        )) as Array<{ request_id: string }>;

        return rows.length > 0;
    }
}
