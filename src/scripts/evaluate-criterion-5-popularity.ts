// Script này đánh giá popularity production với MostPop, RecentPop và DecayPop trên dữ liệu synthetic.
// Script chỉ sinh fixture và đo metric; không đọc log người mua, thay policy production, hay huấn luyện LambdaRank.

import { ConfigService } from '@nestjs/config';
import type { PreferenceValue } from '@/modules/profiles/application/types/profile.types';
import { RecommendationRuleService } from '@/modules/profiles/application/services/rules/recommendation-rule.service';
import { RankingFeatureService } from '@/modules/recommendation/application/services/ranking/features/ranking-feature.service';
import type { RecommendationCandidate } from '@/modules/recommendation/application/types/ranking/ranking.types';

type EventType = 'VIEW' | 'CLICK' | 'CART' | 'PURCHASE';
type SplitName = 'train' | 'validation' | 'test';
type Strategy = 'PERSONALIZED' | 'COLD_START';
type MethodName =
    | 'ProjectPopularity'
    | 'MostPop-sales'
    | 'RecentPop-purchases'
    | 'DecayPop-purchases';
type MetricName = 'ndcgAt10' | 'recallAt10';

interface Product {
    productId: string;
    categoryId: string;
    baseDemand: number;
    changeDay: number;
    demandChange: number;
}

interface Event {
    productId: string;
    day: number;
    type: EventType;
}

interface ProductHistory {
    events: Event[];
}

interface PopularitySnapshot {
    totalSold: number;
    recentPurchases: Map<number, number>;
    decayedPurchases: Map<number, number>;
    trendingScore: number;
}

interface DailySnapshot {
    popularity: Map<string, PopularitySnapshot>;
    trendingRanks: Map<string, number>;
    bestSellingRanks: Map<string, number>;
}

interface CandidateRow {
    productId: string;
    candidate: RecommendationCandidate;
    popularity: PopularitySnapshot;
    relevance: number;
    tieBreaker: number;
}

interface Request {
    requestId: string;
    day: number;
    split: SplitName;
    candidates: CandidateRow[];
}

interface Dataset {
    seed: number;
    trainRequests: Request[];
    validationRequests: Request[];
    testRequests: Request[];
}

interface RequestMetric {
    requestId: string;
    ndcgAt10: number;
    recallAt10: number | null;
}

interface MetricSummary {
    ndcgAt10: number;
    recallAt10: number;
    requestCount: number;
    positiveRequestCount: number;
}

interface Evaluation {
    summary: MetricSummary;
    perRequest: RequestMetric[];
}

interface MethodResult {
    validation: MetricSummary;
    test: Evaluation;
    parameter: number | null;
}

interface SeedResult {
    seed: number;
    methods: Record<MethodName, MethodResult>;
}

interface Spread {
    mean: number;
    sd: number;
    min: number;
    max: number;
}

interface PairedInterval {
    mean: number;
    lower95: number;
    upper95: number;
}

const SEEDS = Array.from({ length: 10 }, (_, index) => 101 + index);
const PRODUCT_COUNT = 80;
const CATEGORY_COUNT = 10;
const TRAIN_FIRST_DAY = 0;
const TRAIN_LAST_DAY = 89;
const TRAIN_REQUEST_FIRST_DAY = 60;
const VALIDATION_FIRST_DAY = 90;
const VALIDATION_LAST_DAY = 104;
const TEST_FIRST_DAY = 105;
const TEST_LAST_DAY = 119;
const REQUESTS_PER_SPLIT = 120;
const IMPRESSIONS_PER_PRODUCT_DAY = 16;
const RECENT_WINDOWS_DAYS = [7, 14, 30, 60] as const;
const DECAY_HALF_LIVES_DAYS = [7, 14, 30, 60] as const;
const TIE_PREFERENCE_DAYS = 30;
const CUTOFF = 10;
const BOOTSTRAP_REPLICATES = 2_000;
const BOOTSTRAP_SEED = 0x5c71a209;
const EMPTY_PREFERENCES: PreferenceValue[] = [];

// Tạo PRNG xác định để cùng seed luôn sinh lại cùng dữ liệu và nhãn.
function createRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        return state / 4_294_967_296;
    };
}

// Tách luồng catalog, lịch sử, query và label để số lần rút ở luồng này không làm đổi luồng kia.
function deriveSeed(seed: number, namespace: string): number {
    let hash = (2_166_136_261 ^ seed) >>> 0;
    for (let index = 0; index < namespace.length; index += 1) {
        hash = Math.imul(hash ^ namespace.charCodeAt(index), 16_777_619) >>> 0;
    }
    return hash;
}

// Giới hạn xác suất và demand latent trong miền xác định trước khi sinh dữ liệu.
function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, value));
}

// Băm request-item thành thứ tự tie-break ổn định, không dùng ID đầu vào để ưu tiên một phương pháp.
function tieBreaker(value: string): number {
    let hash = 2_166_136_261;
    for (let index = 0; index < value.length; index += 1) {
        hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619) >>> 0;
    }
    return hash / 4_294_967_296;
}

// Tạo catalog cân bằng theo category; demand ẩn chỉ sinh historical events và labels, không gọi scoring method.
function createCatalog(seed: number): Product[] {
    const random = createRandom(deriveSeed(seed, 'catalog'));
    return Array.from({ length: PRODUCT_COUNT }, (_, index) => ({
        productId: 'popularity-product-' + String(index + 1).padStart(3, '0'),
        categoryId: 'category-' + (index % CATEGORY_COUNT),
        baseDemand: 0.15 + random() * 0.7,
        changeDay: 20 + Math.floor(random() * 70),
        demandChange:
            random() < 0.5 ? -(0.1 + random() * 0.3) : 0.1 + random() * 0.3,
    }));
}

// Trả demand latent theo ngày; history counts và labels chia sẻ trait ẩn chứ không dùng chung công thức popularity.
function demandAt(product: Product, day: number): number {
    const change = day >= product.changeDay ? product.demandChange : 0;
    return clamp(product.baseDemand + change, 0.05, 0.95);
}

// Sinh view/click/cart/purchase train với số impression bằng nhau giữa sản phẩm để giảm exposure confounding.
function createTrainingEvents(products: Product[], seed: number): Event[] {
    const events: Event[] = [];
    for (const product of products) {
        const random = createRandom(
            deriveSeed(seed, 'history-' + product.productId),
        );
        for (let day = TRAIN_FIRST_DAY; day <= TRAIN_LAST_DAY; day += 1) {
            const demand = demandAt(product, day);
            for (
                let impression = 0;
                impression < IMPRESSIONS_PER_PRODUCT_DAY;
                impression += 1
            ) {
                events.push({
                    productId: product.productId,
                    day,
                    type: 'VIEW',
                });
                if (random() >= 0.12 + 0.58 * demand) continue;
                events.push({
                    productId: product.productId,
                    day,
                    type: 'CLICK',
                });
                if (random() >= 0.1 + 0.35 * demand) continue;
                events.push({
                    productId: product.productId,
                    day,
                    type: 'CART',
                });
                if (random() >= 0.06 + 0.23 * demand) continue;
                events.push({
                    productId: product.productId,
                    day,
                    type: 'PURCHASE',
                });
            }
        }
    }
    return events;
}

// Gom event train theo product để snapshot chỉ đọc dữ liệu của item và không nhận label validation/test.
function indexHistory(
    products: Product[],
    events: Event[],
): Map<string, ProductHistory> {
    const histories = new Map<string, ProductHistory>();
    for (const product of products)
        histories.set(product.productId, { events: [] });
    for (const event of events) {
        const history = histories.get(event.productId);
        if (!history) throw new Error('TRAIN_EVENT_PRODUCT_MISSING');
        history.events.push(event);
    }
    return histories;
}

// Tính số bán, RecentPop, DecayPop và TRENDING chỉ từ event train trước requestDay.
function popularityAsOf(
    history: ProductHistory,
    requestDay: number,
): PopularitySnapshot {
    let totalSold = 0;
    let viewsOneDay = 0;
    let clicksOneDay = 0;
    let cartsSevenDays = 0;
    let purchasesThirtyDays = 0;
    const recentPurchases = new Map<number, number>(
        RECENT_WINDOWS_DAYS.map((window) => [window, 0]),
    );
    const decayedPurchases = new Map<number, number>(
        DECAY_HALF_LIVES_DAYS.map((halfLife) => [halfLife, 0]),
    );
    for (const event of history.events) {
        // Cắt lịch sử tại query (nửa mở) để event cùng ngày và mọi event tương lai đều bị loại.
        if (event.day >= requestDay) continue;
        const age = requestDay - event.day;
        if (event.type === 'VIEW' && age <= 1) viewsOneDay += 1;
        if (event.type === 'CLICK' && age <= 1) clicksOneDay += 1;
        if (event.type === 'CART' && age <= 7) cartsSevenDays += 1;
        if (event.type !== 'PURCHASE') continue;

        totalSold += 1;
        if (age <= 30) purchasesThirtyDays += 1;
        for (const window of RECENT_WINDOWS_DAYS) {
            if (age <= window) {
                recentPurchases.set(
                    window,
                    (recentPurchases.get(window) ?? 0) + 1,
                );
            }
        }
        for (const halfLife of DECAY_HALF_LIVES_DAYS) {
            const previous = decayedPurchases.get(halfLife) ?? 0;
            decayedPurchases.set(halfLife, previous + 2 ** (-age / halfLife));
        }
    }
    return {
        totalSold,
        recentPurchases,
        decayedPurchases,
        trendingScore:
            viewsOneDay * 0.1 +
            clicksOneDay * 0.5 +
            cartsSevenDays * 2 +
            purchasesThirtyDays * 3,
    };
}

// Xếp hạng source point-in-time; tie-break của TRENDING theo totalSold rồi productId như repository.
function rankSource(
    products: Product[],
    popularity: Map<string, PopularitySnapshot>,
    score: (snapshot: PopularitySnapshot) => number,
    useSalesTieBreak: boolean,
): Map<string, number> {
    const ordered = [...products].sort((left, right) => {
        const leftValue = popularity.get(left.productId);
        const rightValue = popularity.get(right.productId);
        if (!leftValue || !rightValue) {
            throw new Error('POINT_IN_TIME_POPULARITY_MISSING');
        }
        const difference = score(rightValue) - score(leftValue);
        if (difference !== 0) return difference;
        if (useSalesTieBreak) {
            const salesDifference = rightValue.totalSold - leftValue.totalSold;
            if (salesDifference !== 0) return salesDifference;
        }
        return left.productId < right.productId
            ? -1
            : left.productId > right.productId
              ? 1
              : 0;
    });
    return new Map(
        ordered.map((product, index) => [product.productId, index + 1]),
    );
}

// Tính daily snapshot một lần cho các request cùng ngày, giữ nguyên candidate source rank và train-only counts.
function createDailySnapshot(
    products: Product[],
    histories: Map<string, ProductHistory>,
    day: number,
): DailySnapshot {
    const popularity = new Map<string, PopularitySnapshot>();
    for (const product of products) {
        const history = histories.get(product.productId);
        if (!history) throw new Error('PRODUCT_HISTORY_MISSING');
        popularity.set(product.productId, popularityAsOf(history, day));
    }
    return {
        popularity,
        trendingRanks: rankSource(
            products,
            popularity,
            (snapshot) => snapshot.trendingScore,
            true,
        ),
        bestSellingRanks: rankSource(
            products,
            popularity,
            (snapshot) => snapshot.totalSold,
            false,
        ),
    };
}

// Tạo candidate contract từ cùng daily snapshot; BEST_SELLING chỉ đi kèm một phần cold-start requests.
function createCandidateRow(
    product: Product,
    snapshot: DailySnapshot,
    strategy: Strategy,
    seed: number,
    requestId: string,
    preferredCategory: string,
    requestDay: number,
    outcomeRandom: () => number,
): CandidateRow {
    const popularity = snapshot.popularity.get(product.productId);
    const trendingRank = snapshot.trendingRanks.get(product.productId);
    const bestSellingRank = snapshot.bestSellingRanks.get(product.productId);
    if (!popularity || !trendingRank || !bestSellingRank) {
        throw new Error('REQUEST_POPULARITY_SNAPSHOT_INCOMPLETE');
    }
    const contributions: NonNullable<RecommendationCandidate['contributions']> =
        [
            {
                source: 'TRENDING',
                rawScore: popularity.trendingScore,
                reasonCode: 'SYNTHETIC_TRENDING',
                sourceRank: trendingRank,
                sourceSize: PRODUCT_COUNT,
            },
        ];
    if (strategy === 'COLD_START') {
        contributions.push({
            source: 'BEST_SELLING',
            rawScore: popularity.totalSold,
            reasonCode: 'SYNTHETIC_BEST_SELLING',
            sourceRank: bestSellingRank,
            sourceSize: PRODUCT_COUNT,
        });
    }
    const candidate: RecommendationCandidate = {
        product: {
            productId: product.productId,
            name: product.productId,
            slug: product.productId,
            imageUrl: null,
            categoryId: product.categoryId,
            brandId: 'brand-' + (Number(product.productId.slice(-3)) % 12),
            sellerShopId: 'synthetic-shop',
            minPrice: '100',
            maxPrice: '100',
            ratingAvg: '4',
            reviewCount: 20,
            totalSold: popularity.totalSold,
            status: 'ACTIVE',
            isInStock: true,
            createdAt: new Date(Date.UTC(2026, 0, 1)),
            updatedAt: new Date(Date.UTC(2026, 0, 1)),
            catalogVersion: 'synthetic-popularity-v1',
            shortDescription: null,
            description: null,
            brandName: null,
            categoryPath: null,
            semanticAttributes: [],
            contentHash: null,
            embeddingStatus: 'NOT_REQUIRED',
            embeddingModelVersion: null,
            embeddingDimensions: null,
        } as RecommendationCandidate['product'],
        sources: new Set(contributions.map((item) => item.source)),
        contributions,
    };

    // Click probability comes from hidden query intent and latent demand, never from a formula or source rank.
    const categoryMatch = Number(product.categoryId === preferredCategory);
    const clickProbability = clamp(
        0.03 + 0.5 * categoryMatch + 0.08 * demandAt(product, requestDay),
        0,
        0.95,
    );
    return {
        productId: product.productId,
        candidate,
        popularity,
        relevance: Number(outcomeRandom() < clickProbability),
        tieBreaker: tieBreaker(
            seed + ':' + requestId + ':' + product.productId,
        ),
    };
}

// Sinh request theo split thời gian; outcome được tạo một lần rồi chia sẻ nguyên trạng cho mọi phương pháp.
function createRequests(
    products: Product[],
    histories: Map<string, ProductHistory>,
    seed: number,
    split: SplitName,
    dailySnapshots: Map<number, DailySnapshot>,
): Request[] {
    const firstDay =
        split === 'train'
            ? TRAIN_REQUEST_FIRST_DAY
            : split === 'validation'
              ? VALIDATION_FIRST_DAY
              : TEST_FIRST_DAY;
    const lastDay =
        split === 'train'
            ? TRAIN_LAST_DAY
            : split === 'validation'
              ? VALIDATION_LAST_DAY
              : TEST_LAST_DAY;
    return Array.from({ length: REQUESTS_PER_SPLIT }, (_, index) => {
        const requestId =
            seed + '-' + split + '-' + String(index + 1).padStart(3, '0');
        const random = createRandom(deriveSeed(seed, 'query-' + requestId));
        const day =
            firstDay +
            Math.floor((index * (lastDay - firstDay + 1)) / REQUESTS_PER_SPLIT);
        const preferredCategory =
            'category-' + Math.floor(random() * CATEGORY_COUNT);
        const strategy: Strategy =
            random() < 0.25 ? 'COLD_START' : 'PERSONALIZED';
        let snapshot = dailySnapshots.get(day);
        if (!snapshot) {
            snapshot = createDailySnapshot(products, histories, day);
            dailySnapshots.set(day, snapshot);
        }
        const outcomeRandom = createRandom(
            deriveSeed(seed, 'outcome-' + requestId),
        );
        return {
            requestId,
            day,
            split,
            candidates: products.map((product) =>
                createCandidateRow(
                    product,
                    snapshot,
                    strategy,
                    seed,
                    requestId,
                    preferredCategory,
                    day,
                    outcomeRandom,
                ),
            ),
        };
    });
}

// Dựng history 0–89 và query splits liên tiếp; validation/test outcomes không được thêm vào history.
function createDataset(seed: number): Dataset {
    const products = createCatalog(seed);
    const histories = indexHistory(
        products,
        createTrainingEvents(products, seed),
    );
    const dailySnapshots = new Map<number, DailySnapshot>();
    return {
        seed,
        trainRequests: createRequests(
            products,
            histories,
            seed,
            'train',
            dailySnapshots,
        ),
        validationRequests: createRequests(
            products,
            histories,
            seed,
            'validation',
            dailySnapshots,
        ),
        testRequests: createRequests(
            products,
            histories,
            seed,
            'test',
            dailySnapshots,
        ),
    };
}

// ProjectPopularity lấy đúng feature từ RankingFeatureService; ba baseline chỉ đọc snapshot history đã chốt.
function scoreCandidate(
    method: MethodName,
    item: CandidateRow,
    parameter: number | null,
    featureBuilder: RankingFeatureService,
    day: number,
): number {
    if (method === 'ProjectPopularity') {
        return featureBuilder.build(
            item.candidate,
            EMPTY_PREFERENCES,
            EMPTY_PREFERENCES,
            EMPTY_PREFERENCES,
            null,
            undefined,
            new Date(Date.UTC(2026, 0, 1 + day)),
        ).popularity;
    }
    if (method === 'MostPop-sales') return item.popularity.totalSold;
    if (method === 'RecentPop-purchases') {
        if (parameter === null) throw new Error('RECENT_PARAMETER_MISSING');
        return item.popularity.recentPurchases.get(parameter) ?? 0;
    }
    if (parameter === null) throw new Error('DECAY_PARAMETER_MISSING');
    return item.popularity.decayedPurchases.get(parameter) ?? 0;
}

// Tính metric trên cùng slate và nhãn; NDCG gồm query không click, Recall macro-average trên query có click.
function evaluateRanking(
    requests: Request[],
    method: MethodName,
    parameter: number | null,
    featureBuilder: RankingFeatureService,
): Evaluation {
    let ndcgTotal = 0;
    let recallTotal = 0;
    let positiveRequestCount = 0;
    const perRequest: RequestMetric[] = [];
    for (const request of requests) {
        const ranked = request.candidates.map((item) => ({
            item,
            score: scoreCandidate(
                method,
                item,
                parameter,
                featureBuilder,
                request.day,
            ),
        }));
        if (ranked.some((row) => !Number.isFinite(row.score))) {
            throw new Error('NON_FINITE_SCORE:' + method);
        }
        // Tie-breaker được tạo trước khi chấm và dùng chung nên không làm lẫn score với thứ tự catalog.
        ranked.sort(
            (left, right) =>
                right.score - left.score ||
                right.item.tieBreaker - left.item.tieBreaker ||
                (left.item.productId < right.item.productId
                    ? -1
                    : left.item.productId > right.item.productId
                      ? 1
                      : 0),
        );
        const relevantCount = request.candidates.reduce(
            (sum, row) => sum + row.relevance,
            0,
        );
        let dcg = 0;
        let hits = 0;
        for (let rank = 0; rank < Math.min(CUTOFF, ranked.length); rank += 1) {
            const row = ranked[rank];
            if (!row || row.item.relevance !== 1) continue;
            dcg += 1 / Math.log2(rank + 2);
            hits += 1;
        }
        let idealDcg = 0;
        for (let rank = 0; rank < Math.min(CUTOFF, relevantCount); rank += 1) {
            idealDcg += 1 / Math.log2(rank + 2);
        }
        const ndcgAt10 = idealDcg === 0 ? 0 : dcg / idealDcg;
        const recallAt10 = relevantCount === 0 ? null : hits / relevantCount;
        ndcgTotal += ndcgAt10;
        if (recallAt10 !== null) {
            recallTotal += recallAt10;
            positiveRequestCount += 1;
        }
        perRequest.push({ requestId: request.requestId, ndcgAt10, recallAt10 });
    }
    return {
        summary: {
            ndcgAt10: requests.length === 0 ? 0 : ndcgTotal / requests.length,
            recallAt10:
                positiveRequestCount === 0
                    ? 0
                    : recallTotal / positiveRequestCount,
            requestCount: requests.length,
            positiveRequestCount,
        },
        perRequest,
    };
}

// Chọn cửa sổ hoặc half-life bằng validation NDCG; khi bằng điểm ưu tiên gần 30 ngày theo baseline nghiên cứu.
function tuneOnValidation(
    requests: Request[],
    method: 'RecentPop-purchases' | 'DecayPop-purchases',
    candidates: readonly number[],
    featureBuilder: RankingFeatureService,
): { parameter: number; summary: MetricSummary } {
    let bestParameter: number | null = null;
    let bestSummary: MetricSummary | null = null;
    for (const parameter of candidates) {
        const summary = evaluateRanking(
            requests,
            method,
            parameter,
            featureBuilder,
        ).summary;
        const bestNdcg = bestSummary?.ndcgAt10 ?? -1;
        const difference = summary.ndcgAt10 - bestNdcg;
        const distance = Math.abs(Math.log(parameter / TIE_PREFERENCE_DAYS));
        const bestDistance =
            bestParameter === null
                ? Number.POSITIVE_INFINITY
                : Math.abs(Math.log(bestParameter / TIE_PREFERENCE_DAYS));
        if (
            bestSummary === null ||
            difference > 1e-12 ||
            (Math.abs(difference) <= 1e-12 && distance < bestDistance)
        ) {
            bestParameter = parameter;
            bestSummary = summary;
        }
    }
    if (bestParameter === null || bestSummary === null) {
        throw new Error('PARAMETER_GRID_MUST_NOT_BE_EMPTY');
    }
    return { parameter: bestParameter, summary: bestSummary };
}

// Tính mean, sample SD và min/max giữa seeds để thể hiện độ nhạy với generator seed.
function summarize(values: number[]): Spread {
    if (values.length === 0) throw new Error('SPREAD_VALUES_MUST_NOT_BE_EMPTY');
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance =
        values.length < 2
            ? 0
            : values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
              (values.length - 1);
    return {
        mean,
        sd: Math.sqrt(variance),
        min: Math.min(...values),
        max: Math.max(...values),
    };
}

// Tạo paired percentile CI bằng cách resample seed như cluster vì các request cùng seed dùng chung catalog/history.
function pairedInterval(
    results: SeedResult[],
    method: MethodName,
    metric: MetricName,
): PairedInterval {
    const differencesBySeed = results.map((result) => {
        const baseline = result.methods[method].test.perRequest;
        const project = result.methods.ProjectPopularity.test.perRequest;
        if (baseline.length !== project.length) {
            throw new Error('PAIRED_REQUEST_COUNT_MISMATCH');
        }
        const differences = baseline.map((row, index) => {
            const projectRow = project[index];
            if (!projectRow || row.requestId !== projectRow.requestId) {
                throw new Error('PAIRED_REQUEST_ORDER_MISMATCH');
            }
            const left = row[metric];
            const right = projectRow[metric];
            return left === null || right === null ? null : left - right;
        });
        const valid = differences.filter(
            (difference): difference is number => difference !== null,
        );
        if (valid.length === 0) throw new Error('NO_PAIRED_METRIC_ROWS');
        return valid;
    });
    const observedSeedMeans = differencesBySeed.map(
        (values) =>
            values.reduce((sum, value) => sum + value, 0) / values.length,
    );
    const mean =
        observedSeedMeans.reduce((sum, value) => sum + value, 0) /
        observedSeedMeans.length;
    const random = createRandom(deriveSeed(BOOTSTRAP_SEED, method + metric));
    const samples = Array.from({ length: BOOTSTRAP_REPLICATES }, () => {
        let total = 0;
        for (let draw = 0; draw < observedSeedMeans.length; draw += 1) {
            const index = Math.floor(random() * observedSeedMeans.length);
            total += observedSeedMeans[index] ?? 0;
        }
        return total / observedSeedMeans.length;
    }).sort((left, right) => left - right);
    return {
        mean,
        lower95: samples[Math.floor(samples.length * 0.025)] ?? 0,
        upper95: samples[Math.ceil(samples.length * 0.975) - 1] ?? 0,
    };
}

// Tune RecentPop/DecayPop trên validation, sau đó đo test một lần với cùng request và candidate set.
function evaluateSeed(
    dataset: Dataset,
    featureBuilder: RankingFeatureService,
): SeedResult {
    const recent = tuneOnValidation(
        dataset.validationRequests,
        'RecentPop-purchases',
        RECENT_WINDOWS_DAYS,
        featureBuilder,
    );
    const decay = tuneOnValidation(
        dataset.validationRequests,
        'DecayPop-purchases',
        DECAY_HALF_LIVES_DAYS,
        featureBuilder,
    );
    const parameters: Record<MethodName, number | null> = {
        ProjectPopularity: null,
        'MostPop-sales': null,
        'RecentPop-purchases': recent.parameter,
        'DecayPop-purchases': decay.parameter,
    };
    const methods = {} as Record<MethodName, MethodResult>;
    for (const method of Object.keys(parameters) as MethodName[]) {
        const parameter = parameters[method];
        const validation =
            method === 'RecentPop-purchases'
                ? recent.summary
                : method === 'DecayPop-purchases'
                  ? decay.summary
                  : evaluateRanking(
                        dataset.validationRequests,
                        method,
                        parameter,
                        featureBuilder,
                    ).summary;
        methods[method] = {
            validation,
            test: evaluateRanking(
                dataset.testRequests,
                method,
                parameter,
                featureBuilder,
            ),
            parameter,
        };
    }
    return { seed: dataset.seed, methods };
}

// Định dạng mean ± SD và khoảng min-max để có thể so sánh spread qua seeds.
function formatSpread(value: Spread): string {
    return (
        value.mean.toFixed(4) +
        ' ± ' +
        value.sd.toFixed(4) +
        ' [' +
        value.min.toFixed(4) +
        ', ' +
        value.max.toFixed(4) +
        ']'
    );
}

// Định dạng delta có dấu và percentile interval; số dương nghĩa baseline vượt project trên metric đó.
function formatInterval(value: PairedInterval): string {
    return (
        (value.mean >= 0 ? '+' : '') +
        value.mean.toFixed(4) +
        ' [' +
        value.lower95.toFixed(4) +
        ', ' +
        value.upper95.toFixed(4) +
        ']'
    );
}

// In metric tổng hợp và từng seed gọn để có thể kiểm tra spread, tham số và ghép cặp.
function printReport(results: SeedResult[]): void {
    const methods: MethodName[] = [
        'ProjectPopularity',
        'MostPop-sales',
        'RecentPop-purchases',
        'DecayPop-purchases',
    ];
    const spreadFor = (
        method: MethodName,
        split: 'validation' | 'test',
        metric: MetricName,
    ): Spread =>
        summarize(
            results.map((result) =>
                split === 'test'
                    ? result.methods[method].test.summary[metric]
                    : result.methods[method].validation[metric],
            ),
        );
    process.stdout.write(
        'Criterion 5 — synthetic popularity evaluation\n' +
            'Seeds: ' +
            SEEDS.join(', ') +
            '; catalog=' +
            PRODUCT_COUNT +
            ' products / ' +
            CATEGORY_COUNT +
            ' categories; same candidate pool per request; K=' +
            CUTOFF +
            '.\n' +
            'Train events: days ' +
            TRAIN_FIRST_DAY +
            '–' +
            TRAIN_LAST_DAY +
            '; request days: train ' +
            TRAIN_REQUEST_FIRST_DAY +
            '–' +
            TRAIN_LAST_DAY +
            ', validation ' +
            VALIDATION_FIRST_DAY +
            '–' +
            VALIDATION_LAST_DAY +
            ', test ' +
            TEST_FIRST_DAY +
            '–' +
            TEST_LAST_DAY +
            '; ' +
            REQUESTS_PER_SPLIT +
            ' requests/split/seed.\n' +
            'RecentPop window grid=' +
            RECENT_WINDOWS_DAYS.join(',') +
            ' days; DecayPop half-life grid=' +
            DECAY_HALF_LIVES_DAYS.join(',') +
            ' days; validation NDCG@10 selects parameters per seed.\n' +
            'Labels are Bernoulli clicks from hidden category intent and latent demand with separate RNG; tested scores do not generate labels. No AI model is trained.\n' +
            'Popularity uses only training events with event day < request day; held-out outcomes never update its history.\n\n',
    );
    process.stdout.write(
        '| Method | Validation NDCG@10 mean ± seed SD | Test NDCG@10 mean ± seed SD [min,max] | Test Recall@10 mean ± seed SD [min,max] |\n' +
            '| --- | ---: | ---: | ---: |\n',
    );
    for (const method of methods) {
        process.stdout.write(
            '| ' +
                method +
                ' | ' +
                formatSpread(spreadFor(method, 'validation', 'ndcgAt10')) +
                ' | ' +
                formatSpread(spreadFor(method, 'test', 'ndcgAt10')) +
                ' | ' +
                formatSpread(spreadFor(method, 'test', 'recallAt10')) +
                ' |\n',
        );
    }
    process.stdout.write(
        '\nPer-seed test results (NDCG@10 / Recall@10; RecentPop window and DecayPop half-life chosen on validation):\n' +
            '| Seed | Recent window | Decay half-life | Project | MostPop | RecentPop | DecayPop |\n' +
            '| ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n' +
            results
                .map((result) => {
                    // In từng cặp NDCG/Recall đã làm tròn để soi độ biến thiên giữa các seed.
                    const metricPair = (method: MethodName): string =>
                        result.methods[method].test.summary.ndcgAt10.toFixed(
                            4,
                        ) +
                        ' / ' +
                        result.methods[method].test.summary.recallAt10.toFixed(
                            4,
                        );
                    return (
                        '| ' +
                        result.seed +
                        ' | ' +
                        result.methods['RecentPop-purchases'].parameter +
                        ' days | ' +
                        result.methods['DecayPop-purchases'].parameter +
                        ' days | ' +
                        metricPair('ProjectPopularity') +
                        ' | ' +
                        metricPair('MostPop-sales') +
                        ' | ' +
                        metricPair('RecentPop-purchases') +
                        ' | ' +
                        metricPair('DecayPop-purchases') +
                        ' |'
                    );
                })
                .join('\n') +
            '\n\nPaired test deltas vs ProjectPopularity (baseline minus project; 95% percentile bootstrap CI resampling seed-level clusters):\n' +
            '| Method | Δ NDCG@10 [95% CI] | Δ Recall@10 [95% CI] |\n' +
            '| --- | ---: | ---: |\n',
    );
    for (const method of methods) {
        if (method === 'ProjectPopularity') continue;
        process.stdout.write(
            '| ' +
                method +
                ' | ' +
                formatInterval(pairedInterval(results, method, 'ndcgAt10')) +
                ' | ' +
                formatInterval(pairedInterval(results, method, 'recallAt10')) +
                ' |\n',
        );
    }
    process.stdout.write(
        '\nPaired bootstrap: ' +
            BOOTSTRAP_REPLICATES +
            ' seed-cluster resamples; seed=' +
            BOOTSTRAP_SEED +
            '. Each cluster is one seed-level paired mean across its requests; with 10 clusters, CI is exploratory. Seed SD reports generator spread.\n' +
            'Synthetic caveat: equal exposure, fixed 80-item catalog and the declared latent-demand click model do not represent real shoppers or production candidate coverage; results are not proof of formula optimality.\n',
    );
}

// Khởi tạo feature builder mặc định và biến lỗi thành exit code khác 0 để lệnh shell không báo đạt giả.
function main(): void {
    try {
        const config = {
            get: (_key: string, fallback?: string) => fallback,
        } as ConfigService;
        const featureBuilder = new RankingFeatureService(
            new RecommendationRuleService(config),
        );
        const results = SEEDS.map((seed) =>
            evaluateSeed(createDataset(seed), featureBuilder),
        );
        printReport(results);
    } catch (error) {
        const message =
            error instanceof Error ? error.message : 'UNKNOWN_EVALUATION_ERROR';
        process.stderr.write(
            'Criterion 5 popularity evaluator failed: ' + message + '\n',
        );
        process.exitCode = 1;
    }
}

main();
