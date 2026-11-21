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
//   --rows 100000 `
//   --seed 42 `
//   --output ../../services/ai-service/data/ranking-synthetic/v3-seed-42
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
import {
    SYNTHETIC_FEATURE_ORDER,
    SYNTHETIC_SESSION_INTERVAL_MS,
} from '@/modules/recommendation/application/types/offline/ranking-synthetic.types';

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

    // Tạo slate và event giả theo seed cố định để tái lập được cùng dataset.
    // Mỗi request chỉ dùng catalog item đã tồn tại tại thời điểm request.
    // Feature profile và freshness cũng được tính theo chính thời điểm đó để tránh nhìn thấy dữ liệu tương lai.
    // Service chỉ trả dữ liệu trong memory; CLI sở hữu việc ghi file offline, không publish event nghiệp vụ.
    generate(
        catalog: RecommendationCatalogProduct[],
        options: RankingSyntheticOptions,
    ): RankingSyntheticDataset {
        this.validateInput(catalog, options);
        const random = this.createRandom(options.seed);
        const orderedCatalog = [...catalog].sort((left, right) =>
            left.productId.localeCompare(right.productId),
        );
        const firstRequestAt = new Date(
            options.referenceTime.getTime() -
                options.sessions * SYNTHETIC_SESSION_INTERVAL_MS,
        );
        const initialCatalog = orderedCatalog.filter(
            (product) =>
                product.createdAt.getTime() <= firstRequestAt.getTime(),
        );
        if (initialCatalog.length < 8)
            throw new Error('SYNTHETIC_CATALOG_HAS_TOO_FEW_PRODUCTS_AT_START');
        // Persona chỉ lấy category/brand đã có ở mốc đầu để hồ sơ giả không học từ catalog tương lai.
        const personas = this.createPersonas(
            initialCatalog,
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
                Math.ceil(options.targetRows / Math.max(options.sessions, 1)),
            ),
        );

        for (let index = 0; index < options.sessions; index += 1) {
            const persona = personas[index % personas.length];
            if (!persona) throw new Error('SYNTHETIC_PERSONA_MISSING');
            // Timestamp được tính trước để catalog, user context và feature cùng dùng một mốc as-of.
            const requestAt = new Date(
                options.referenceTime.getTime() -
                    (options.sessions - index) * SYNTHETIC_SESSION_INTERVAL_MS,
            );
            const availableCatalog = orderedCatalog.filter(
                (product) => product.createdAt.getTime() <= requestAt.getTime(),
            );
            if (availableCatalog.length < 8)
                throw new Error(
                    'SYNTHETIC_CATALOG_HAS_TOO_FEW_PRODUCTS_AS_OF_REQUEST',
                );
            const session = this.createSession(
                persona,
                index,
                requestAt,
                availableCatalog,
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
                availableCatalog,
                candidatesPerSession,
                random,
            );
            events.push(...result.events);
            rows.push(...result.rows);
        }

        return { catalog: orderedCatalog, personas, sessions, events, rows };
    }

    // Chặn input không hợp lệ trước khi sinh dữ liệu để mỗi request có slate đủ lớn cho pairwise ranking.
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
        if (!Number.isInteger(options.targetRows) || options.targetRows < 1)
            throw new Error('SYNTHETIC_TARGET_ROWS_MUST_BE_POSITIVE');
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

    // Tạo session tại timestamp đã được chọn trước để split, catalog availability và feature clock không lệch nhau.
    // Anchor product chỉ được chọn từ catalog đã có ở request này; nếu không còn item hợp sở thích thì dùng catalog khả dụng.
    private createSession(
        persona: RankingSyntheticPersona,
        index: number,
        requestAt: Date,
        catalog: RecommendationCatalogProduct[],
        random: RandomSource,
    ): RankingSyntheticSession {
        const matching = catalog.filter((product) =>
            this.matchesPersona(product, persona),
        );
        const anchor = this.pick(matching.length ? matching : catalog, random);
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
            createdAt: requestAt.toISOString(),
            split: 'train',
        };
    }

    // Sinh slate, feature và outcome từ cùng một request snapshot theo timeline giả lập.
    // Slate loại anchor đang xem; chỉ candidate có trong catalog tại request mới được chấm feature.
    // Nhãn sinh từ utility ẩn không phụ thuộc vị trí hiển thị và không bị ép cân bằng theo từng query.
    // Dữ liệu chỉ phục vụ phát triển pipeline, không đại diện hành vi khách thật.
    private simulateSession(
        persona: RankingSyntheticPersona,
        session: RankingSyntheticSession,
        catalog: RecommendationCatalogProduct[],
        candidateCount: number,
        random: RandomSource,
    ): { events: RankingSyntheticEvent[]; rows: RankingSyntheticRow[] } {
        const candidates = this.sampleCandidates(
            catalog,
            persona,
            candidateCount,
            session.currentProductId,
            random,
        );
        const sessionTime = new Date(session.createdAt);
        const preferences = this.buildPreferences(persona, session);
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
        const actions = candidates.map((product) =>
            this.simulateAction(
                this.hiddenUtility(product, persona, random),
                persona.riskTolerance,
                random,
            ),
        );
        const rows: RankingSyntheticRow[] = [];
        const events: RankingSyntheticEvent[] = [];

        candidates.forEach((product, index) => {
            const position = index + 1;
            const candidate = this.toCandidate(product, persona, session);
            const vector = this.features.build(
                candidate,
                preferences.product,
                preferences.category,
                preferences.brand,
                context,
                undefined,
                sessionTime,
            );
            const action = actions[index];
            if (!action) throw new Error('SYNTHETIC_ACTION_MISSING');
            rows.push({
                datasetVersion: 'ranking-synthetic-v3',
                featureSchemaVersion: 'ranking-features-v3',
                userId: persona.userId,
                sessionId: session.sessionId,
                requestId: session.requestId,
                requestAt: session.createdAt,
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
                requestAt: session.createdAt,
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
                    requestAt: session.createdAt,
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

    // Attribution khớp nhánh chọn candidate: match persona vào category/brand, item khác là exploration.
    // Popularity lấy từ catalog snapshot; không gán sourceRank theo slate và không giả co-behavior khi thiếu lịch sử.
    private toCandidate(
        product: RecommendationCatalogProduct,
        persona: RankingSyntheticPersona,
        session: RankingSyntheticSession,
    ): RecommendationCandidate {
        const matchesCategory = Boolean(
            product.categoryId &&
            persona.categoryIds.includes(product.categoryId),
        );
        const matchesBrand = Boolean(
            product.brandId && persona.brandIds.includes(product.brandId),
        );
        const sources = new Set<string>();
        if (matchesCategory) sources.add('CATEGORY_AFFINITY');
        if (matchesBrand) sources.add('BRAND_AFFINITY');
        if (!matchesCategory && !matchesBrand) sources.add('EXPLORE');
        const contributions: NonNullable<
            RecommendationCandidate['contributions']
        > = [];
        if (session.currentProductId !== product.productId) {
            contributions.push({
                source: 'SEMANTIC_SIMILARITY',
                rawScore: this.similarityScore(product, session),
                reasonCode: 'SYNTHETIC_SEMANTIC_SIGNAL',
                anchorProductId: session.currentProductId ?? undefined,
            });
        }
        return { product, sources, contributions };
    }

    // Tạo relevance utility từ persona và catalog, không đưa thứ tự slate vào nhãn.
    // Vị trí hiển thị không được trộn vào popularity/sourceRank nên holdout không thưởng cho thứ tự ngẫu nhiên ban đầu.
    private hiddenUtility(
        product: RecommendationCatalogProduct,
        persona: RankingSyntheticPersona,
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
        const noise = (random() - 0.5) * 0.24;
        return this.clamp(
            categoryFit * 0.28 +
                brandFit * 0.18 +
                priceFit * 0.18 +
                rating * 0.16 +
                popularity * 0.1 +
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

    // Lấy slate không lặp từ nhánh affinity và exploration, đồng thời loại anchor đang được xem.
    // Tỷ lệ ưu tiên chỉ quyết định thành phần mục tiêu; nếu một nhóm thiếu item thì phần còn lại được bù từ nhóm kia.
    // Nếu catalog chỉ còn ít item, slate được phép ngắn hơn mục tiêu thay vì lặp hoặc đưa anchor trở lại.
    private sampleCandidates(
        catalog: RecommendationCatalogProduct[],
        persona: RankingSyntheticPersona,
        count: number,
        excludedProductId: string | null,
        random: RandomSource,
    ): RecommendationCatalogProduct[] {
        const eligibleCatalog = catalog.filter(
            (product) => product.productId !== excludedProductId,
        );
        if (eligibleCatalog.length < 2)
            throw new Error('SYNTHETIC_CANDIDATE_POOL_TOO_SMALL');
        const shuffled = [...eligibleCatalog];
        // Fisher–Yates tạo hoán vị deterministic theo PRNG thay vì comparator ngẫu nhiên không có thứ tự ổn định.
        for (let index = shuffled.length - 1; index > 0; index -= 1) {
            const otherIndex = Math.floor(random() * (index + 1));
            [shuffled[index], shuffled[otherIndex]] = [
                shuffled[otherIndex]!,
                shuffled[index]!,
            ];
        }
        const matching = shuffled.filter((product) =>
            this.matchesPersona(product, persona),
        );
        const nonMatching = shuffled.filter(
            (product) => !this.matchesPersona(product, persona),
        );
        const targetCount = Math.min(count, eligibleCatalog.length);
        const preferredCount = Math.min(
            matching.length,
            Math.floor(targetCount * 0.55),
        );
        const nonMatchingCount = Math.min(
            nonMatching.length,
            targetCount - preferredCount,
        );
        const selected = [
            ...matching.slice(0, preferredCount),
            ...nonMatching.slice(0, nonMatchingCount),
        ];
        const remaining = [
            ...matching.slice(preferredCount),
            ...nonMatching.slice(nonMatchingCount),
        ];
        const slate = [...selected, ...remaining].slice(0, targetCount);
        // Xáo slate sau khi áp quota để vị trí hiển thị không mã hóa nhánh affinity hay exploration.
        for (let index = slate.length - 1; index > 0; index -= 1) {
            const otherIndex = Math.floor(random() * (index + 1));
            [slate[index], slate[otherIndex]] = [
                slate[otherIndex]!,
                slate[index]!,
            ];
        }
        return slate;
    }

    // Dựng profile giả dùng riêng cho request, không ghi vào profile projection của hệ thống.
    // Mỗi tín hiệu được đặt trước thời điểm request một ngày để decay không đọc từ tương lai.
    private buildPreferences(
        persona: RankingSyntheticPersona,
        session: RankingSyntheticSession,
    ): {
        product: PreferenceValue[];
        category: PreferenceValue[];
        brand: PreferenceValue[];
    } {
        const lastSignalAt = new Date(
            new Date(session.createdAt).getTime() - DAY_MS,
        );
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
            positiveScore: Math.max(0, score),
            negativeScore: Math.max(0, -score),
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

    // Gán split theo thời gian session; user có thể xuất hiện lại ở giai đoạn sau như trong đánh giá temporal thực tế.
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
        const shuffled = [...values];
        // Dùng cùng PRNG deterministic để thứ tự persona không phụ thuộc comparator ngẫu nhiên.
        for (let index = shuffled.length - 1; index > 0; index -= 1) {
            const otherIndex = Math.floor(random() * (index + 1));
            [shuffled[index], shuffled[otherIndex]] = [
                shuffled[otherIndex]!,
                shuffled[index]!,
            ];
        }
        const count = Math.min(
            values.length,
            min + Math.floor(random() * (max - min + 1)),
        );
        return shuffled.slice(0, count);
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
