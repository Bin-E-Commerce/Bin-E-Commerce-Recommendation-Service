// Entity lưu snapshot point-in-time do Recommendation Service tạo; không liên kết khóa ngoại sang service khác.

import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('recommendation_training_snapshots')
@Index('UQ_recommendation_training_snapshots_request', ['requestId'], {
    unique: true,
})
@Index('IDX_recommendation_training_snapshots_served_at', ['servedAt'])
@Index('IDX_recommendation_training_snapshots_surface_served_at', [
    'surface',
    'servedAt',
])
// Entity là bằng chứng đầu vào ranker theo request; không thay thế event table hoặc actor profile.
export class RecommendationTrainingSnapshotEntity {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    // Request ID là khóa join với event attribution và lớp dedupe khi retry ghi snapshot.
    @Column({ name: 'request_id', type: 'varchar', length: 128 })
    requestId!: string;

    // Hai mốc tách thời điểm dùng để tính feature khỏi thời điểm response thực sự được phục vụ.
    @Column({ name: 'served_at', type: 'timestamptz' })
    servedAt!: Date;

    @Column({ name: 'features_computed_at', type: 'timestamptz' })
    featuresComputedAt!: Date;

    @Column({ type: 'varchar', length: 32 })
    environment!: string;

    @Column({ type: 'varchar', length: 32 })
    surface!: string;

    @Column({ type: 'integer' })
    page!: number;

    @Column({ type: 'varchar', length: 32 })
    strategy!: string;

    @Column({ name: 'ranking_mode', type: 'varchar', length: 24 })
    rankingMode!: string;

    @Column({
        name: 'ranking_model_version',
        type: 'varchar',
        length: 128,
        nullable: true,
    })
    rankingModelVersion!: string | null;

    @Column({ name: 'ranking_policy_version', type: 'varchar', length: 64 })
    rankingPolicyVersion!: string;

    @Column({ name: 'feature_schema_version', type: 'varchar', length: 64 })
    featureSchemaVersion!: string;

    @Column({ name: 'candidate_budget', type: 'integer' })
    candidateBudget!: number;

    @Column({ name: 'candidate_count', type: 'integer' })
    candidateCount!: number;

    @Column({ name: 'selected_candidate_count', type: 'integer' })
    selectedCandidateCount!: number;

    // Mỗi source giữ danh sách ID có thứ tự, số lượng gốc và cờ giới hạn để phân tích candidate generation.
    @Column({ name: 'source_candidates', type: 'jsonb' })
    sourceCandidates!: unknown[];

    // Tối đa 300 candidate có feature, score và rank sau diversity; item không được exposure sẽ không tự thành negative.
    @Column({ type: 'jsonb' })
    candidates!: unknown[];

    @CreateDateColumn({ name: 'captured_at', type: 'timestamptz' })
    capturedAt!: Date;
}
