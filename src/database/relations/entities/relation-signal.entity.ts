import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryColumn,
} from 'typeorm';

// Read model riêng của relation projector; không phụ thuộc timing commit của interaction/profile projector.
@Entity('recommendation_relation_signals')
@Index('idx_recommendation_relation_signals_session_occurred', [
    'sessionId',
    'occurredAt',
])
@Index('idx_recommendation_relation_signals_user_occurred', [
    'userId',
    'occurredAt',
])
@Index('idx_recommendation_relation_signals_product_occurred', [
    'productId',
    'occurredAt',
])
@Index('idx_recommendation_relation_signals_occurred', ['occurredAt'])
export class RecommendationRelationSignalEntity {
    // Event ID ổn định giúp relation signal không bị ghi trùng khi Kafka redelivery.
    @PrimaryColumn({ name: 'event_id', type: 'varchar', length: 128 })
    eventId!: string;

    @Column({ name: 'user_id', type: 'varchar', length: 128, nullable: true })
    userId!: string | null;

    @Column({
        name: 'session_id',
        type: 'varchar',
        length: 128,
        nullable: true,
    })
    sessionId!: string | null;

    @Column({ name: 'interaction_type', type: 'varchar', length: 64 })
    interactionType!: string;

    @Column({ name: 'product_id', type: 'varchar', length: 128 })
    productId!: string;

    @Column({ name: 'occurred_at', type: 'timestamptz' })
    occurredAt!: Date;

    @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
    createdAt!: Date;
}
