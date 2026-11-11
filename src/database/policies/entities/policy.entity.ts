// Entity này giữ lại ranking policy history cũ để audit; các record legacy không điều khiển LambdaRank serving hiện tại.

import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('recommendation_policies')
@Index('idx_recommendation_policies_status_created', ['status', 'createdAt'])
@Index('uq_recommendation_policies_version', ['version'], { unique: true })
export class RecommendationPolicyEntity {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    // Version immutable giúp cache, trace và rollback luôn tham chiếu được đúng policy đã dùng.
    @Column({ type: 'varchar', length: 128 })
    version!: string;

    @Column({ type: 'varchar', length: 16, default: 'ACTIVE' })
    status!: 'ACTIVE' | 'ARCHIVED';

    // JSON giữ cấu hình policy legacy để đọc lại lịch sử, không được dùng làm feature weights hoặc model blend.
    @Column({ type: 'jsonb' })
    config!: Record<string, unknown>;

    @Column({
        name: 'created_by',
        type: 'varchar',
        length: 128,
        nullable: true,
    })
    createdBy!: string | null;

    @Column({ type: 'varchar', length: 500, nullable: true })
    reason!: string | null;

    @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
    createdAt!: Date;
}
