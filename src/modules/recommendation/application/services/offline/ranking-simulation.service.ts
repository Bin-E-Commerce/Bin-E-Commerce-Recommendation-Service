// Service này mô phỏng user/session/event và tạo feature dataset offline; không publish Kafka, không ghi profile và không gọi AI Service.
// Service này tự tạo:
// - User giả.
// - Session giả.
// - Sản phẩm đang xem.
// - Impression.
// - Click.
// - Xem chi tiết.
// - Thêm vào giỏ.
// - Mua hàng giả lập.

// npm run ranking-simulate --workspace @bin-ecommerce/recommendation-service -- `
//   --users 1000 `
//   --sessions 5000 `
//   --events 100000 `
//   --seed 42 `
//   --output ../../services/ai-service/data/ranking-synthetic/pilot-1000u-5000s-seed42
import { Injectable } from '@nestjs/common';
import type {
    PreferenceValue,
    SessionContext,
} from '@/modules/profiles/application/types/profile.types';
import type { RecommendationCatalogProduct } from '@/modules/catalog/application/types/catalog-product.type';
import { RankingFeatureService } from '@/modules/recommendation/application/services/ranking/features/ranking-feature.service';
import type {
    RankingFeatureVector,
    RecommendationCandidate,
} from '@/modules/recommendation/application/types/ranking/ranking.types';
import type {
    RankingSyntheticDataset,
    RankingSyntheticEvent,
    RankingSyntheticOptions,
    RankingSyntheticPersona,
    RankingSyntheticRow,
    RankingSyntheticSession,
    SyntheticDatasetSplit,
    SyntheticInteractionType,
} from '@/modules/recommendation/application/types/offline/ranking-synthetic.types';
import { SYNTHETIC_FEATURE_ORDER } from '@/modules/recommendation/application/types/offline/ranking-synthetic.types';

const DAY_MS = 86_400_000;

type RandomSource = () => number;

interface SyntheticAction {
    positive: boolean;
    eventType: SyntheticInteractionType;
    eventTypes: SyntheticInteractionType[];
}

@Injectable()
export class RankingSimulationService {
    constructor(private readonly features: RankingFeatureService) {}

    // Tạo dataset tái lập từ catalog snapshot bằng seed cố định; side effect được giữ ngoài service để CLI chỉ ghi file offline.
    generate(
        catalog: RecommendationCatalogProduct[],
        options: RankingSyntheticOptions,
    ): RankingSyntheticDataset {
        this.validateInput(catalog, options);
        const random = this.createRandom(options.seed);
        const orderedCatalog = [...catalog].sort((left, right) =>
            left.productId.localeCompare(right.productId),
        );
        const personas = this.createPersonas(
            orderedCatalog,
            options.users,
            random,
        );
        const sessions: RankingSyntheticSession[] = [];
        const events: RankingSyntheticEvent[] = [];
        const rows: RankingSyntheticRow[] = [];
        const candidatesPerSession = Math.max(
            8,
            Math.min(
                24,
                Math.ceil(options.targetEvents / Math.max(options.sessions, 1)),
            ),
        );

        for (let index = 0; index < options.sessions; index += 1) {
            const persona = personas[index % personas.length];
            if (!persona) throw new Error('SYNTHETIC_PERSONA_MISSING');
            const session = this.createSession(
                persona,
                index,
                options,
                orderedCatalog,
                random,
            );
            const sessionWithSplit = {
                ...session,
                split: this.splitFor(index, options.sessions),
            };
            sessions.push(sessionWithSplit);
            const result = this.simulateSession(
                persona,
                sessionWithSplit,
                orderedCatalog,
                candidatesPerSession,
                options,
                random,
            );
            events.push(...result.events);
            rows.push(...result.rows);
        }

        return { catalog: orderedCatalog, personas, sessions, events, rows };
    }

    // Chặn input không hợp lệ trước khi sinh dữ liệu để tránh tạo dataset thiếu class hoặc thiếu candidate.
    private validateInput(
        catalog: RecommendationCatalogProduct[],
        options: RankingSyntheticOptions,
    ): void {
        if (catalog.length < 8)
            throw new Error('SYNTHETIC_CATALOG_REQUIRES_8_PRODUCTS');
        if (!Number.isInteger(options.users) || options.users < 1)
            throw new Error('SYNTHETIC_USERS_MUST_BE_POSITIVE');
        if (!Number.isInteger(options.sessions) || options.sessions < 1)
            throw new Error('SYNTHETIC_SESSIONS_MUST_BE_POSITIVE');
        if (!Number.isInteger(options.targetEvents) || options.targetEvents < 1)
            throw new Error('SYNTHETIC_EVENTS_MUST_BE_POSITIVE');
        if (!Number.isInteger(options.seed))
            throw new Error('SYNTHETIC_SEED_MUST_BE_INTEGER');
        if (Number.isNaN(options.referenceTime.getTime()))
            throw new Error('SYNTHETIC_REFERENCE_TIME_INVALID');
    }

    // Tạo PRNG nhỏ, deterministic và không dùng cho bảo mật; seed giúp dataset có thể tái lập khi debug/training.
    private createRandom(seed: number): RandomSource {
        let state = seed >>> 0;
        return () => {
            state += 0x6d2b79f5;
            let value = state;
            value = Math.imul(value ^ (value >>> 15), value | 1);
            value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
            return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
        };
    }

    // Sinh persona từ category/brand thật để synthetic behavior bám phân phối catalog thay vì tạo ID không tồn tại.
    private createPersonas(
        catalog: RecommendationCatalogProduct[],
        count: number,
        random: RandomSource,
    ): RankingSyntheticPersona[] {
        const categoryIds = this.uniqueValues(
            catalog.map((product) => product.categoryId),
        );
        const brandIds = this.uniqueValues(
            catalog.map((product) => product.brandId),
        );
        const prices = catalog
            .map((product) => Number(product.minPrice))
            .filter(Number.isFinite);
        const minPrice = prices.length ? Math.min(...prices) : 0;
        const maxPrice = prices.length ? Math.max(...prices) : 1;

        return Array.from({ length: count }, (_, index) => ({
            userId: `synthetic-user-${String(index + 1).padStart(4, '0')}`,
            categoryIds: this.pickValues(categoryIds, 1, 2, random),
            brandIds: this.pickValues(brandIds, 1, 2, random),
            minPrice: this.randomBetween(minPrice, maxPrice * 0.65, random),
            maxPrice: this.randomBetween(maxPrice * 0.65, maxPrice, random),
            riskTolerance: this.randomBetween(0.15, 0.85, random),
        }));
    }

    // Tạo session theo timeline cố định để split theo thời gian và freshness không phụ thuộc thời điểm chạy CLI.
    private createSession(
        persona: RankingSyntheticPersona,
        index: number,
        options: RankingSyntheticOptions,
        catalog: RecommendationCatalogProduct[],
        random: RandomSource,
    ): RankingSyntheticSession {
        const matching = catalog.filter((product) =>
            this.matchesPersona(product, persona),
        );
        const anchor = this.pick(matching.length ? matching : catalog, random);
        const createdAt = new Date(
            options.referenceTime.getTime() -
                (options.sessions - index) * 2 * 60 * 60 * 1000,
        );
        const sequence = String(index + 1).padStart(5, '0');
        return {
            userId: persona.userId,
            sessionId: `synthetic-session-${sequence}`,
            requestId: `synthetic-request-${sequence}`,
            surface: this.pick(
                ['home', 'product_detail', 'recommendations_page'] as const,
                random,
            ),
            currentProductId: anchor.productId,
            recentProductIds: [anchor.productId],
            recentCategoryIds: anchor.categoryId ? [anchor.categoryId] : [],
            recentBrandIds: anchor.brandId ? [anchor.brandId] : [],
            createdAt: createdAt.toISOString(),
            split: 'train',
        };
    }

    // Sinh impression và funnel action theo utility ẩn; label chỉ nhìn hành động sau impression.
    private simulateSession(
        persona: RankingSyntheticPersona,
        session: RankingSyntheticSession,
        catalog: RecommendationCatalogProduct[],
        candidateCount: number,
        options: RankingSyntheticOptions,
        random: RandomSource,
    ): { events: RankingSyntheticEvent[]; rows: RankingSyntheticRow[] } {
        const candidates = this.sampleCandidates(
            catalog,
            persona,
            candidateCount,
            random,
        );
        const preferences = this.buildPreferences(persona, session, options);
        const context: SessionContext = {
            sessionId: session.sessionId,
            recentProductIds: session.recentProductIds,
            recentProductSignals: [],
            recentCategoryIds: session.recentCategoryIds,
            recentBrandIds: session.recentBrandIds,
            currentProductId: session.currentProductId,
            currentCategoryId: session.recentCategoryIds[0] ?? null,
            latestQuery: null,
            cartProductIds: [],
            intentUpdatedAt: session.createdAt,
            version: 1,
        };
        const actions = candidates.map((product, index) =>
            this.simulateAction(
                this.hiddenUtility(product, persona, index + 1, random),
                persona.riskTolerance,
                random,
            ),
        );
        this.ensurePositiveAndNegative(actions);
        const rows: RankingSyntheticRow[] = [];
        const events: RankingSyntheticEvent[] = [];
        const sessionTime = new Date(session.createdAt);

        candidates.forEach((product, index) => {
            const position = index + 1;
            const candidate = this.toCandidate(
                product,
                session,
                index,
                candidates.length,
            );
            const vector = this.features.build(
                candidate,
                preferences.product,
                preferences.category,
                preferences.brand,
                context,
                undefined,
                options.referenceTime,
            );
            const action = actions[index];
            if (!action) throw new Error('SYNTHETIC_ACTION_MISSING');
            rows.push({
                datasetVersion: 'ranking-synthetic-v1',
                featureSchemaVersion: 'ranking-features-v1',
                userId: persona.userId,
                sessionId: session.sessionId,
                requestId: session.requestId,
                itemId: product.productId,
                position,
                features: this.toFeatureRow(vector),
                label: action.positive ? 1 : 0,
                eventType: action.eventType,
                split: session.split,
            });
            events.push({
                eventId: `${session.requestId}-impression-${position}`,
                userId: persona.userId,
                sessionId: session.sessionId,
                requestId: session.requestId,
                itemId: product.productId,
                interactionType: 'PRODUCT_IMPRESSED',
                position,
                occurredAt: sessionTime.toISOString(),
            });
            action.eventTypes.forEach((eventType, eventIndex) => {
                events.push({
                    eventId: `${session.requestId}-${eventType.toLowerCase()}-${position}`,
                    userId: persona.userId,
                    sessionId: session.sessionId,
                    requestId: session.requestId,
                    itemId: product.productId,
                    interactionType: eventType,
                    position,
                    occurredAt: new Date(
                        sessionTime.getTime() + (index + eventIndex + 1) * 1000,
                    ).toISOString(),
                });
            });
        });

        return { events, rows };
    }

    // Tạo contribution giả tối thiểu để semantic, co-behavior và exploration feature chạy qua production feature builder.
    private toCandidate(
        product: RecommendationCatalogProduct,
        session: RankingSyntheticSession,
        index: number,
        sourceSize: number,
    ): RecommendationCandidate {
        const rank = index + 1;
        const sources = new Set<string>(['EXPLORE']);
        const contributions: NonNullable<
            RecommendationCandidate['contributions']
        > = [
            {
                source: 'BEST_SELLING',
                rawScore: product.totalSold,
                reasonCode: 'SYNTHETIC_CATALOG_SIGNAL',
                sourceRank: rank,
                sourceSize,
            },
        ];
        if (
            product.categoryId &&
            session.recentCategoryIds.includes(product.categoryId)
        )
            sources.add('CATEGORY_AFFINITY');
        if (product.brandId && session.recentBrandIds.includes(product.brandId))
            sources.add('BRAND_AFFINITY');
        if (session.currentProductId !== product.productId) {
            contributions.push({
                source: 'SEMANTIC_SIMILARITY',
                rawScore: this.similarityScore(product, session),
                reasonCode: 'SYNTHETIC_SEMANTIC_SIGNAL',
                anchorProductId: session.currentProductId ?? undefined,
            });
        }
        if (index % 3 === 0 && product.productId !== session.currentProductId) {
            sources.add('CO_BEHAVIOR');
            contributions.push({
                source: 'CO_BEHAVIOR',
                rawScore: 2 + (index % 4),
                reasonCode: 'SYNTHETIC_CO_BEHAVIOR_SIGNAL',
                relationType: 'CO_VIEW',
                anchorProductId: session.currentProductId ?? undefined,
            });
        }
        return { product, sources, contributions };
    }

    // Xấp xỉ mức phù hợp ẩn bằng tín hiệu persona/catalog độc lập với điểm Hybrid.
    private hiddenUtility(
        product: RecommendationCatalogProduct,
        persona: RankingSyntheticPersona,
        position: number,
        random: RandomSource,
    ): number {
        const categoryFit =
            product.categoryId &&
            persona.categoryIds.includes(product.categoryId)
                ? 1
                : 0;
        const brandFit =
            product.brandId && persona.brandIds.includes(product.brandId)
                ? 1
                : 0;
        const price = Number(product.minPrice);
        const targetPrice = (persona.minPrice + persona.maxPrice) / 2;
        const priceFit = Number.isFinite(price)
            ? this.clamp(
                  1 -
                      Math.abs(price - targetPrice) /
                          Math.max(persona.maxPrice, 1),
              )
            : 0;
        const rating = this.clamp(Number(product.ratingAvg ?? 0) / 5);
        const popularity = this.clamp(
            Math.log1p(Math.max(product.totalSold, 0)) / 12,
        );
        const positionBias = 1 / Math.log2(position + 1);
        const noise = (random() - 0.5) * 0.24;
        return this.clamp(
            categoryFit * 0.28 +
                brandFit * 0.18 +
                priceFit * 0.18 +
                rating * 0.16 +
                popularity * 0.1 +
                positionBias * 0.1 +
                noise,
        );
    }

    // Chuyển utility thành funnel action thưa dần để dataset có negative impression và positive interaction.
    private simulateAction(
        utility: number,
        riskTolerance: number,
        random: RandomSource,
    ): SyntheticAction {
        const clickProbability = this.clamp(0.08 + utility * 0.58);
        if (random() >= clickProbability)
            return {
                positive: false,
                eventType: 'PRODUCT_IMPRESSED',
                eventTypes: [],
            };
        const eventTypes: SyntheticInteractionType[] = [
            'PRODUCT_CLICKED',
            'PRODUCT_VIEWED',
        ];
        const cartProbability = this.clamp(
            0.08 + utility * 0.35 + riskTolerance * 0.12,
        );
        if (random() < cartProbability) {
            eventTypes.push('PRODUCT_ADDED_TO_CART');
            const purchaseProbability = this.clamp(
                0.04 + utility * 0.2 + riskTolerance * 0.08,
            );
            if (random() < purchaseProbability) {
                eventTypes.push('PURCHASE_COMPLETED');
                return {
                    positive: true,
                    eventType: 'PURCHASE_COMPLETED',
                    eventTypes,
                };
            }
            return {
                positive: true,
                eventType: 'PRODUCT_ADDED_TO_CART',
                eventTypes,
            };
        }
        return {
            positive: true,
            eventType: 'PRODUCT_CLICKED',
            eventTypes,
        };
    }

    // Bảo đảm mỗi request có cả positive và negative để binary trainer không nhận batch toàn một class.
    private ensurePositiveAndNegative(actions: SyntheticAction[]): void {
        if (actions.length < 2) return;
        if (!actions.some((action) => action.positive)) {
            actions[0] = {
                positive: true,
                eventType: 'PRODUCT_CLICKED',
                eventTypes: ['PRODUCT_CLICKED', 'PRODUCT_VIEWED'],
            };
        }
        if (!actions.some((action) => !action.positive)) {
            actions[actions.length - 1] = {
                positive: false,
                eventType: 'PRODUCT_IMPRESSED',
                eventTypes: [],
            };
        }
    }

    // Tạo candidate set có item hợp sở thích và item explore để model học trong cùng recommendation request.
    private sampleCandidates(
        catalog: RecommendationCatalogProduct[],
        persona: RankingSyntheticPersona,
        count: number,
        random: RandomSource,
    ): RecommendationCatalogProduct[] {
        const shuffled = [...catalog].sort(() => random() - 0.5);
        const matching = shuffled.filter((product) =>
            this.matchesPersona(product, persona),
        );
        const nonMatching = shuffled.filter(
            (product) => !this.matchesPersona(product, persona),
        );
        const preferredCount = Math.max(2, Math.floor(count * 0.55));
        return [
            ...matching.slice(0, preferredCount),
            ...nonMatching.slice(0, count - preferredCount),
            ...matching.slice(preferredCount),
        ].slice(0, Math.min(count, catalog.length));
    }

    // Dựng preference tạm trong memory, tuyệt đối không ghi vào profile projection của hệ thống.
    private buildPreferences(
        persona: RankingSyntheticPersona,
        session: RankingSyntheticSession,
        options: RankingSyntheticOptions,
    ): {
        product: PreferenceValue[];
        category: PreferenceValue[];
        brand: PreferenceValue[];
    } {
        const lastSignalAt = new Date(options.referenceTime.getTime() - DAY_MS);
        return {
            product: session.currentProductId
                ? [
                      this.preference(
                          persona,
                          'PRODUCT',
                          session.currentProductId,
                          5,
                          lastSignalAt,
                      ),
                  ]
                : [],
            category: persona.categoryIds.map((id) =>
                this.preference(persona, 'CATEGORY', id, 7, lastSignalAt),
            ),
            brand: persona.brandIds.map((id) =>
                this.preference(persona, 'BRAND', id, 6, lastSignalAt),
            ),
        };
    }

    // Tạo preference object đúng application type để feature builder production xử lý như profile hợp lệ.
    private preference(
        persona: RankingSyntheticPersona,
        dimension: PreferenceValue['dimension'],
        dimensionKey: string,
        score: number,
        lastSignalAt: Date,
    ): PreferenceValue {
        return {
            actorType: 'USER',
            actorId: persona.userId,
            dimension,
            dimensionKey,
            score,
            interactionCount: 3,
            lastSignalAt,
        };
    }

    // Chuyển vector object sang thứ tự contract cố định mà AI Service đang nhận.
    private toFeatureRow(features: RankingFeatureVector): number[] {
        return SYNTHETIC_FEATURE_ORDER.map((feature) =>
            this.clamp(features[feature]),
        );
    }

    // Gán split theo thứ tự session để tránh rò rỉ cùng request/user giữa train, validation và test.
    private splitFor(index: number, total: number): SyntheticDatasetSplit {
        const ratio = index / Math.max(total, 1);
        if (ratio < 0.7) return 'train';
        if (ratio < 0.85) return 'validation';
        return 'test';
    }

    private matchesPersona(
        product: RecommendationCatalogProduct,
        persona: RankingSyntheticPersona,
    ): boolean {
        return Boolean(
            (product.categoryId &&
                persona.categoryIds.includes(product.categoryId)) ||
            (product.brandId && persona.brandIds.includes(product.brandId)),
        );
    }

    private similarityScore(
        product: RecommendationCatalogProduct,
        session: RankingSyntheticSession,
    ): number {
        const category =
            product.categoryId &&
            session.recentCategoryIds.includes(product.categoryId)
                ? 0.7
                : 0.1;
        const brand =
            product.brandId && session.recentBrandIds.includes(product.brandId)
                ? 0.25
                : 0;
        return this.clamp(category + brand);
    }

    private uniqueValues(values: Array<string | null>): string[] {
        return [
            ...new Set(
                values.filter((value): value is string => Boolean(value)),
            ),
        ];
    }

    private pickValues(
        values: string[],
        min: number,
        max: number,
        random: RandomSource,
    ): string[] {
        if (values.length === 0) return [];
        const count = Math.min(
            values.length,
            min + Math.floor(random() * (max - min + 1)),
        );
        return [...values].sort(() => random() - 0.5).slice(0, count);
    }

    private pick<T>(values: readonly T[], random: RandomSource): T {
        const value = values[Math.floor(random() * values.length)];
        if (value === undefined) throw new Error('SYNTHETIC_RANDOM_PICK_EMPTY');
        return value;
    }

    private randomBetween(
        min: number,
        max: number,
        random: RandomSource,
    ): number {
        return min + (max - min) * random();
    }

    private clamp(value: number): number {
        return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
    }
}
