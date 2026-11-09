// Kiểm tra SQL projection thật trên PostgreSQL dùng một database tạm tên profile_affinity_test ở localhost.
// Script chỉ tạo/xóa bảng thử trong database tạm và từ chối kết nối tới database khác.

import { DataSource } from 'typeorm';
import { AddProfileDecayedComponents1788035000000 } from '@/database/migrations/1788035000000-add-profile-decayed-components';
import { RecommendationActorPreferenceEntity } from '@/database/profiles/entities/actor-preference.entity';
import { RecommendationActorProfileEntity } from '@/database/profiles/entities/actor-profile.entity';
import { ProfileProjectionRepository } from '@/modules/profiles/infrastructure/repositories/profile-projection.repository';
import { ProfileQueryRepository } from '@/modules/profiles/infrastructure/repositories/profile-query.repository';

const DAY_MS = 86_400_000;
const H = 7;
const referenceTime = new Date('2026-11-09T00:00:00.000Z');

// So sánh số thực với tổng trực tiếp từ từng event để phát hiện lỗi SQL, không sao chép recurrence.
function assertClose(actual: number, expected: number, label: string): void {
    if (Math.abs(actual - expected) > 1e-9) {
        throw new Error(`${label}: expected ${expected}, got ${actual}`);
    }
}

// Tạo chuỗi giả ngẫu nhiên cố định để lặp nhiều thứ tự nhận event và cả tín hiệu âm.
function randomGenerator(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4_294_967_296;
    };
}

// Mỗi actor nhận 6 event không theo thứ tự; đối chiếu hai tổng SQL với định nghĩa tổng từng event.
async function verify(): Promise<void> {
    const databaseUrl = process.env.PROFILE_AFFINITY_TEST_DATABASE_URL;
    if (!databaseUrl)
        throw new Error('PROFILE_AFFINITY_TEST_DATABASE_URL_REQUIRED');
    const parsed = new URL(databaseUrl);
    if (
        !['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
        parsed.pathname !== '/profile_affinity_test'
    ) {
        throw new Error(
            'PROFILE_AFFINITY_TEST_DATABASE_MUST_BE_LOCAL_AND_ISOLATED',
        );
    }
    const dataSource = new DataSource({
        type: 'postgres',
        url: databaseUrl,
        extra: { max: 1 },
        entities: [
            RecommendationActorPreferenceEntity,
            RecommendationActorProfileEntity,
        ],
        synchronize: false,
    });
    await dataSource.initialize();
    try {
        await dataSource.query(`CREATE TABLE recommendation_actor_preferences (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            actor_type varchar(16) NOT NULL,
            actor_id varchar(128) NOT NULL,
            dimension varchar(24) NOT NULL,
            dimension_key varchar(255) NOT NULL,
            score double precision NOT NULL DEFAULT 0,
            interaction_count integer NOT NULL DEFAULT 0,
            last_signal_at timestamptz NOT NULL,
            updated_at timestamptz NOT NULL DEFAULT now(),
            UNIQUE (actor_type, actor_id, dimension, dimension_key)
        )`);
        await dataSource.query(
            `INSERT INTO recommendation_actor_preferences (actor_type, actor_id, dimension, dimension_key, score, last_signal_at)
             VALUES ('USER', 'legacy', 'PRODUCT', 'P', 4, $1)`,
            [referenceTime],
        );
        const migrationRunner = dataSource.createQueryRunner();
        await migrationRunner.connect();
        try {
            await new AddProfileDecayedComponents1788035000000().up(
                migrationRunner,
            );
        } finally {
            await migrationRunner.release();
        }
        const legacy = (await dataSource.query(
            `SELECT positive_score, negative_score FROM recommendation_actor_preferences WHERE actor_id = 'legacy'`,
        )) as Array<{ positive_score: number; negative_score: number }>;
        if (
            legacy[0]?.positive_score !== 4 ||
            legacy[0]?.negative_score !== 0
        ) {
            throw new Error('LEGACY_BACKFILL_FAILED');
        }
        await dataSource.query(`CREATE TABLE recommendation_actor_profiles (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            actor_type varchar(16) NOT NULL,
            actor_id varchar(128) NOT NULL,
            last_interaction_at timestamptz,
            profile_version integer NOT NULL DEFAULT 1,
            merged_at timestamptz,
            merged_user_id varchar(128),
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            UNIQUE (actor_type, actor_id)
        )`);
        const repository = new ProfileProjectionRepository(dataSource);
        const weights = [0.05, 1, 2, 4, 8, -2, -8];

        for (let seed = 1; seed <= 100; seed += 1) {
            const random = randomGenerator(seed);
            const events = Array.from({ length: 6 }, () => ({
                score: weights[Math.floor(random() * weights.length)]!,
                occurredAt: new Date(
                    referenceTime.getTime() -
                        Math.floor(random() * 31) * DAY_MS,
                ),
            }));
            // Đảo thứ tự ghi để kiểm tra event đến trễ; tổng trực tiếp không phụ thuộc thứ tự.
            events.sort(() => random() - 0.5);
            for (const event of events) {
                await repository.upsertPreference(
                    {
                        actorType: 'USER',
                        actorId: `synthetic-${seed}`,
                        dimension: 'PRODUCT',
                        dimensionKey: 'P',
                        score: event.score,
                        occurredAt: event.occurredAt,
                        halfLifeDays: H,
                    },
                    dataSource.manager,
                );
            }
            const rows = (await dataSource.query(
                `SELECT positive_score, negative_score, interaction_count, last_signal_at
                 FROM recommendation_actor_preferences WHERE actor_id = $1`,
                [`synthetic-${seed}`],
            )) as Array<{
                positive_score: number;
                negative_score: number;
                interaction_count: number;
                last_signal_at: Date;
            }>;
            const row = rows[0];
            if (!row) throw new Error(`PROFILE_ROW_MISSING:${seed}`);
            const anchor = Math.max(
                ...events.map((event) => event.occurredAt.getTime()),
            );
            const directPositive = events.reduce(
                (sum, event) =>
                    sum +
                    Math.max(0, event.score) *
                        Math.pow(
                            0.5,
                            (anchor - event.occurredAt.getTime()) / DAY_MS / H,
                        ),
                0,
            );
            const directNegative = events.reduce(
                (sum, event) =>
                    sum +
                    Math.max(0, -event.score) *
                        Math.pow(
                            0.5,
                            (anchor - event.occurredAt.getTime()) / DAY_MS / H,
                        ),
                0,
            );
            assertClose(row.positive_score, directPositive, `positive:${seed}`);
            assertClose(row.negative_score, directNegative, `negative:${seed}`);
            if (
                row.interaction_count !== events.length ||
                row.last_signal_at.getTime() !== anchor
            ) {
                throw new Error(`PROFILE_METADATA_MISMATCH:${seed}`);
            }
        }
        // Guest merge phải đưa hai aggregate về cùng mốc; context không được làm mới tín hiệu user đã có.
        const oldTime = new Date(referenceTime.getTime() - 14 * DAY_MS);
        for (const [actorType, actorId, key, score, occurredAt] of [
            ['USER', 'user-merge', 'P', 8, oldTime],
            ['USER', 'user-merge', 'Q', 8, oldTime],
            ['SESSION', 'guest-merge', 'P', 2, referenceTime],
        ] as const) {
            await repository.upsertPreference(
                {
                    actorType,
                    actorId,
                    dimension: 'PRODUCT',
                    dimensionKey: key,
                    score,
                    occurredAt,
                    halfLifeDays: H,
                },
                dataSource.manager,
            );
        }
        await dataSource.query(
            `INSERT INTO recommendation_actor_profiles (actor_type, actor_id, last_interaction_at)
             VALUES ('SESSION', 'guest-merge', $1)`,
            [referenceTime],
        );
        const queryRepository = new ProfileQueryRepository(
            dataSource,
            dataSource.getRepository(RecommendationActorPreferenceEntity),
        );
        const context = {
            recentProductIds: ['Q'],
            recentCategoryIds: [],
            recentBrandIds: [],
            currentProductId: null,
            currentCategoryId: null,
            latestQuery: null,
            cartProductIds: [],
            intentUpdatedAt: referenceTime.toISOString(),
        };
        const merged = await queryRepository.mergeGuestSession(
            'user-merge',
            'guest-merge',
            H,
            context,
        );
        const mergedAgain = await queryRepository.mergeGuestSession(
            'user-merge',
            'guest-merge',
            H,
            context,
        );
        if (!merged || mergedAgain)
            throw new Error('GUEST_MERGE_IDEMPOTENCY_FAILED');
        const mergedRows = (await dataSource.query(
            `SELECT dimension_key, positive_score, last_signal_at
             FROM recommendation_actor_preferences WHERE actor_type = 'USER' AND actor_id = 'user-merge'`,
        )) as Array<{
            dimension_key: string;
            positive_score: number;
            last_signal_at: Date;
        }>;
        const mergedP = mergedRows.find((row) => row.dimension_key === 'P');
        const existingQ = mergedRows.find((row) => row.dimension_key === 'Q');
        if (!mergedP || !existingQ) throw new Error('GUEST_MERGE_ROWS_MISSING');
        assertClose(mergedP.positive_score, 4, 'merged-positive-P');
        assertClose(existingQ.positive_score, 8, 'unrefreshed-context-Q');
        if (existingQ.last_signal_at.getTime() !== oldTime.getTime()) {
            throw new Error('CONTEXT_REFRESHED_EXISTING_PREFERENCE');
        }
        await repository.upsertPreference(
            {
                actorType: 'USER',
                actorId: 'user-merge',
                dimension: 'PRODUCT',
                dimensionKey: 'R',
                score: -8,
                occurredAt: referenceTime,
                halfLifeDays: H,
            },
            dataSource.manager,
        );
        const top = await queryRepository.findTop(
            'USER',
            'user-merge',
            'PRODUCT',
        );
        const negativeR = top.find((value) => value.dimensionKey === 'R');
        if (top.length !== 3 || negativeR?.negativeScore !== 8) {
            throw new Error('POSITIVE_NEGATIVE_QUERY_FAILED');
        }
        const narrowTop = await queryRepository.findTop(
            'USER',
            'user-merge',
            'PRODUCT',
            1,
            H,
            referenceTime,
        );
        if (
            narrowTop.length !== 2 ||
            !narrowTop.some((value) => value.dimensionKey === 'P')
        ) {
            throw new Error('EFFECTIVE_SCORE_QUERY_ORDER_FAILED');
        }
        process.stdout.write(
            'PASS: migration, 100 actors, 600 out-of-order events; guest merge, context chronology, idempotency and time-aware top query.\n',
        );
    } finally {
        await dataSource.query(
            'DROP TABLE IF EXISTS recommendation_actor_preferences',
        );
        await dataSource.query(
            'DROP TABLE IF EXISTS recommendation_actor_profiles',
        );
        await dataSource.destroy();
    }
}

void verify().catch((error: unknown) => {
    process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
});
