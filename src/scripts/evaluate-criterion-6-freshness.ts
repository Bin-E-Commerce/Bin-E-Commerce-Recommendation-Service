// Script này đo riêng feature freshness trên dữ liệu synthetic có nhãn tách khỏi score được so sánh.
// Nó gọi feature builder production để lấy bucket hiện tại, không huấn luyện model và không đọc dữ liệu thật.
// Các kết quả chỉ kiểm tra giả định synthetic; không được diễn giải thành bằng chứng hiệu quả với người mua.

import { ConfigService } from '@nestjs/config';
import { RecommendationRuleService } from '@/modules/profiles/application/services/rules/recommendation-rule.service';
import type { RecommendationCatalogProduct } from '@/modules/catalog/application/types/catalog-product.type';
import { RankingFeatureService } from '@/modules/recommendation/application/services/ranking/features/ranking-feature.service';
import type { RecommendationCandidate } from '@/modules/recommendation/application/types/ranking/ranking.types';

type EvaluationSplit = 'train' | 'validation' | 'test';
type ScenarioName = 'age-sensitive' | 'age-neutral';
type MethodName = 'production-bucket' | 'exponential-decay' | 'no-freshness';

interface SyntheticProduct {
    productId: string;
    categoryId: string;
    brandId: string;
    quality: number;
    createdAtMs: number;
}

interface RawCandidate {
    product: SyntheticProduct;
    displayPosition: number;
    outcomeUniform: number;
}

interface RawRequest {
    requestId: string;
    userId: string;
    requestAtMs: number;
    split: EvaluationSplit;
    preferredCategoryId: string;
    preferredBrandId: string;
    candidates: RawCandidate[];
}

interface CandidateObservation extends RawCandidate {
    ageDays: number;
    clickProbability: number;
    clicked: 0 | 1;
    clickAtMs?: number;
}

interface EvaluationRequest extends Omit<RawRequest, 'candidates'> {
    candidates: CandidateObservation[];
}

interface QueryMetrics {
    ndcgAt10: number;
    recallAt10: number | null;
}

interface AggregateMetrics {
    ndcgAt10: number;
    recallAt10: number;
    requestCount: number;
    requestCountWithClicks: number;
    impressionCount: number;
    clickCount: number;
}

interface SeedMethodResult extends AggregateMetrics {
    seed: number;
    selectedHalfLifeDays?: number;
}

interface SpreadSummary {
    mean: number;
    standardDeviation: number;
    minimum: number;
    maximum: number;
}

interface PairedConfidenceInterval {
    meanDifference: number;
    lower95: number;
    upper95: number;
    pairedSeedCount: number;
}

interface MetricSpread {
    ndcgAt10: SpreadSummary;
    recallAt10: SpreadSummary;
}

interface ScenarioResult {
    selectedHalfLifeDays: number;
    validationByHalfLife: Array<{
        halfLifeDays: number;
        ndcgAt10: number;
    }>;
    testByMethod: Record<
        MethodName,
        {
            metrics: MetricSpread;
            seeds: SeedMethodResult[];
        }
    >;
    pairedTestDifferences: Record<
        string,
        {
            ndcgAt10: PairedConfidenceInterval;
            recallAt10: PairedConfidenceInterval;
        }
    >;
}

interface SplitCounts {
    requestCount: number;
    candidateImpressions: number;
    clicks: number;
    firstRequestAt: string | null;
    lastRequestAt: string | null;
}

interface ScenarioDataset {
    requests: EvaluationRequest[];
    eventCounts: { impressions: number; clicks: number };
}

const SEEDS = Array.from({ length: 12 }, (_, index) => 20261111 + index * 97);
const REQUESTS_PER_SEED = 600;
const PRODUCTS_PER_SEED = 500;
const CANDIDATES_PER_REQUEST = 30;
const CATEGORY_COUNT = 12;
const BRAND_COUNT = 10;
const CUTOFF = 10;
const REQUEST_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;
const START_TIME_MS = Date.parse('2026-01-01T00:00:00.000Z');
const VALIDATION_START_INDEX = Math.floor(REQUESTS_PER_SEED * 0.6);
const TEST_START_INDEX = Math.floor(REQUESTS_PER_SEED * 0.8);
const HALF_LIFE_GRID_DAYS = [7, 14, 21, 30, 45, 60, 90, 120, 180, 240];
const EXPONENTIAL_FLOOR = 0.1;
const BOOTSTRAP_REPLICATES = 2_000;
const CONFIDENCE_SEED = 204017;

type FreshnessFeatureReader = (
    candidate: RecommendationCandidate,
    referenceTime: Date,
) => number;

// PRNG tuyến tính tạo cùng catalog, request và click outcome từ seed cố định.
function createRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        return state / 4_294_967_296;
    };
}

// Băm khóa request/item thành thứ tự phá hòa ổn định để baseline không có feature không thiên vị theo thứ tự mảng.
function stableTieBreaker(value: string): number {
    let hash = 2_166_136_261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16_777_619) >>> 0;
    }
    return hash / 4_294_967_296;
}

// Tạo catalog sao cho tuổi sản phẩm độc lập với category, brand và quality; candidate tương lai bị chặn lúc tạo request.
function createCatalog(seed: number): SyntheticProduct[] {
    const ageRandom = createRandom(seed + 1);
    const attributeRandom = createRandom(seed + 2);
    const catalogEndMs =
        START_TIME_MS + REQUESTS_PER_SEED * REQUEST_INTERVAL_MS;
    const catalogStartMs = START_TIME_MS - 120 * DAY_MS;
    const catalogSpanMs = catalogEndMs - catalogStartMs;

    return Array.from({ length: PRODUCTS_PER_SEED }, (_, index) => ({
        productId: `seed-${seed}-product-${String(index + 1).padStart(4, '0')}`,
        categoryId: `category-${Math.floor(attributeRandom() * CATEGORY_COUNT)}`,
        brandId: `brand-${Math.floor(attributeRandom() * BRAND_COUNT)}`,
        quality: attributeRandom(),
        createdAtMs: catalogStartMs + Math.floor(ageRandom() * catalogSpanMs),
    }));
}

// Lấy không hoàn lại một candidate pool từ sản phẩm đã tồn tại tại request, tránh rò rỉ item ra mắt sau đó.
function sampleCandidates(
    products: SyntheticProduct[],
    requestAtMs: number,
    random: () => number,
): SyntheticProduct[] {
    const available = products.filter(
        (product) => product.createdAtMs <= requestAtMs,
    );
    if (available.length < CANDIDATES_PER_REQUEST) {
        throw new Error('SYNTHETIC_CATALOG_HAS_TOO_FEW_AVAILABLE_PRODUCTS');
    }

    for (let index = 0; index < CANDIDATES_PER_REQUEST; index += 1) {
        const swapIndex =
            index + Math.floor(random() * (available.length - index));
        [available[index], available[swapIndex]] = [
            available[swapIndex]!,
            available[index]!,
        ];
    }
    return available.slice(0, CANDIDATES_PER_REQUEST);
}

// Chia cohort theo thứ tự timestamp; mỗi request và user giả chỉ thuộc duy nhất một split.
function resolveSplit(requestIndex: number): EvaluationSplit {
    if (requestIndex < VALIDATION_START_INDEX) return 'train';
    if (requestIndex < TEST_START_INDEX) return 'validation';
    return 'test';
}

// Sinh impression requests theo thời gian; outcome được tạo từ stream riêng, không dùng score của công thức đang so.
function createRawRequests(
    seed: number,
    products: SyntheticProduct[],
): RawRequest[] {
    const requestRandom = createRandom(seed + 3);
    const outcomeRandom = createRandom(seed + 4);

    return Array.from({ length: REQUESTS_PER_SEED }, (_, requestIndex) => {
        const requestAtMs = START_TIME_MS + requestIndex * REQUEST_INTERVAL_MS;
        const candidates = sampleCandidates(
            products,
            requestAtMs,
            requestRandom,
        );
        const preferredCategoryId = `category-${Math.floor(requestRandom() * CATEGORY_COUNT)}`;
        const preferredBrandId = `brand-${Math.floor(requestRandom() * BRAND_COUNT)}`;

        return {
            requestId: `seed-${seed}-request-${String(requestIndex + 1).padStart(4, '0')}`,
            userId: `seed-${seed}-user-${String(requestIndex + 1).padStart(4, '0')}`,
            requestAtMs,
            split: resolveSplit(requestIndex),
            preferredCategoryId,
            preferredBrandId,
            candidates: candidates.map((product, candidateIndex) => ({
                product,
                displayPosition: candidateIndex + 1,
                outcomeUniform: outcomeRandom(),
            })),
        };
    });
}

// Mô phỏng click bằng latent intent, quality và prior novelty tuyến tính; nhãn không đọc bucket hay hàm mũ được đánh giá.
function generateClickProbability(
    candidate: RawCandidate,
    request: RawRequest,
    scenario: ScenarioName,
): {
    ageDays: number;
    probability: number;
    clicked: 0 | 1;
    clickAtMs?: number;
} {
    const ageDays = Math.max(
        0,
        (request.requestAtMs - candidate.product.createdAtMs) / DAY_MS,
    );
    const categoryMatch = Number(
        candidate.product.categoryId === request.preferredCategoryId,
    );
    const brandMatch = Number(
        candidate.product.brandId === request.preferredBrandId,
    );
    const independentLinearNovelty = Math.max(0, 1 - ageDays / 180);
    const ageUtility =
        scenario === 'age-sensitive' ? 0.35 * independentLinearNovelty : 0;
    const probability = Math.min(
        0.9,
        0.025 +
            0.14 * candidate.product.quality +
            0.25 * categoryMatch +
            0.1 * brandMatch +
            ageUtility,
    );
    const clicked = Number(candidate.outcomeUniform < probability) as 0 | 1;

    return {
        ageDays,
        probability,
        clicked,
        ...(clicked ? { clickAtMs: request.requestAtMs + 60_000 } : {}),
    };
}

// Gán outcome synthetic sau mỗi impression; age-neutral cho phép đo khi tuổi sản phẩm không mang tín hiệu relevance.
function materializeScenario(
    rawRequests: RawRequest[],
    scenario: ScenarioName,
): ScenarioDataset {
    let impressions = 0;
    let clicks = 0;
    const requests = rawRequests.map((request) => ({
        ...request,
        candidates: request.candidates.map((candidate) => {
            const outcome = generateClickProbability(
                candidate,
                request,
                scenario,
            );
            impressions += 1;
            clicks += outcome.clicked;

            return {
                ...candidate,
                ageDays: outcome.ageDays,
                clickProbability: outcome.probability,
                clicked: outcome.clicked,
                ...(outcome.clickAtMs === undefined
                    ? {}
                    : { clickAtMs: outcome.clickAtMs }),
            };
        }),
    }));

    return { requests, eventCounts: { impressions, clicks } };
}

// Biến catalog giả thành read model tối thiểu mà feature builder production nhận vào.
function toRecommendationCandidate(
    product: SyntheticProduct,
): RecommendationCandidate {
    const catalogProduct: RecommendationCatalogProduct = {
        productId: product.productId,
        name: product.productId,
        slug: product.productId,
        imageUrl: null,
        categoryId: product.categoryId,
        brandId: product.brandId,
        sellerShopId: null,
        minPrice: '1',
        maxPrice: '1',
        ratingAvg: null,
        reviewCount: 0,
        totalSold: 0,
        status: 'ACTIVE',
        isInStock: true,
        createdAt: new Date(product.createdAtMs),
        updatedAt: new Date(product.createdAtMs),
        catalogVersion: 'synthetic-v1',
        shortDescription: null,
        description: null,
        brandName: null,
        categoryPath: null,
        semanticAttributes: [],
        contentHash: null,
        embeddingStatus: 'NOT_REQUIRED',
        embeddingModelVersion: null,
        embeddingDimensions: null,
    };

    return {
        product: catalogProduct,
        sources: new Set<string>(),
        contributions: [],
    };
}

// Đọc đúng bucket production bằng feature builder thay vì sao chép logic ngưỡng vào evaluator.
function createProductionFreshnessReader(): FreshnessFeatureReader {
    const config = {
        get: (_key: string, fallback?: string) => fallback,
    } as ConfigService;
    const rules = new RecommendationRuleService(config);
    const featureService = new RankingFeatureService(rules);
    const emptyPreferences: never[] = [];

    return (candidate, referenceTime) =>
        featureService.build(
            candidate,
            emptyPreferences,
            emptyPreferences,
            emptyPreferences,
            null,
            undefined,
            referenceTime,
        ).freshness;
}

// Tính NDCG@10 và Recall@10 cho một request, dùng stable tie-break giống nhau giữa tất cả phương pháp.
function measureRequest(
    request: EvaluationRequest,
    score: (
        candidate: CandidateObservation,
        request: EvaluationRequest,
    ) => number,
): QueryMetrics {
    const ranked = [...request.candidates].sort((left, right) => {
        const scoreDifference = score(right, request) - score(left, request);
        if (scoreDifference !== 0) return scoreDifference;
        return (
            stableTieBreaker(`${request.requestId}:${left.product.productId}`) -
            stableTieBreaker(`${request.requestId}:${right.product.productId}`)
        );
    });
    const relevantCount = request.candidates.reduce(
        (sum, candidate) => sum + candidate.clicked,
        0,
    );
    let dcg = 0;
    let hits = 0;

    for (let rank = 0; rank < CUTOFF; rank += 1) {
        const candidate = ranked[rank];
        if (!candidate || candidate.clicked === 0) continue;
        dcg += 1 / Math.log2(rank + 2);
        hits += 1;
    }

    let idealDcg = 0;
    for (let rank = 0; rank < Math.min(relevantCount, CUTOFF); rank += 1) {
        idealDcg += 1 / Math.log2(rank + 2);
    }

    return {
        ndcgAt10: idealDcg === 0 ? 0 : dcg / idealDcg,
        recallAt10: relevantCount === 0 ? null : hits / relevantCount,
    };
}

// Đo từng query riêng để paired bootstrap so đúng cùng request và nhãn giữa hai cách xếp hạng.
function measureQueries(
    requests: EvaluationRequest[],
    score: (
        candidate: CandidateObservation,
        request: EvaluationRequest,
    ) => number,
): QueryMetrics[] {
    return requests.map((request) => measureRequest(request, score));
}

// Tổng hợp macro-average theo query; Recall chỉ lấy request có click để mẫu số xác định.
function aggregateQueryMetrics(
    requests: EvaluationRequest[],
    queryMetrics: QueryMetrics[],
): AggregateMetrics {
    const recallValues = queryMetrics.flatMap((metric) =>
        metric.recallAt10 === null ? [] : [metric.recallAt10],
    );
    const clickCount = requests.reduce(
        (sum, request) =>
            sum +
            request.candidates.reduce(
                (rowSum, item) => rowSum + item.clicked,
                0,
            ),
        0,
    );

    return {
        ndcgAt10:
            queryMetrics.length === 0
                ? 0
                : queryMetrics.reduce(
                      (sum, metric) => sum + metric.ndcgAt10,
                      0,
                  ) / queryMetrics.length,
        recallAt10:
            recallValues.length === 0
                ? 0
                : recallValues.reduce((sum, value) => sum + value, 0) /
                  recallValues.length,
        requestCount: requests.length,
        requestCountWithClicks: recallValues.length,
        impressionCount: requests.reduce(
            (sum, request) => sum + request.candidates.length,
            0,
        ),
        clickCount,
    };
}

// Thăm dò lưới H trên validation; ranking riêng freshness không thể nhận diện H vì mọi H giữ nguyên thứ tự tuổi.
function tuneHalfLife(validationBySeed: Map<number, EvaluationRequest[]>): {
    selectedHalfLifeDays: number;
    validationByHalfLife: ScenarioResult['validationByHalfLife'];
} {
    const rows = HALF_LIFE_GRID_DAYS.map((halfLifeDays) => {
        let total = 0;
        let count = 0;
        for (const requests of validationBySeed.values()) {
            for (const request of requests) {
                const metric = measureRequest(request, (candidate) =>
                    exponentialDecayScore(candidate.ageDays, halfLifeDays),
                );
                total += metric.ndcgAt10;
                count += 1;
            }
        }
        return { halfLifeDays, ndcgAt10: count === 0 ? 0 : total / count };
    });
    const ranked = [...rows].sort(
        (left, right) =>
            right.ndcgAt10 - left.ndcgAt10 ||
            left.halfLifeDays - right.halfLifeDays,
    );
    const selected = ranked[0];
    if (!selected)
        throw new Error('FRESHNESS_HALF_LIFE_GRID_MUST_NOT_BE_EMPTY');

    return {
        selectedHalfLifeDays: selected.halfLifeDays,
        validationByHalfLife: rows,
    };
}

// Tính exponential freshness với cùng điểm sàn 0.10; half-life chỉ được chọn từ validation.
function exponentialDecayScore(ageDays: number, halfLifeDays: number): number {
    return (
        EXPONENTIAL_FLOOR +
        (1 - EXPONENTIAL_FLOOR) * Math.pow(0.5, ageDays / halfLifeDays)
    );
}

// Sắp xếp các phương án trên cùng một request/candidate set; bucket lấy kết quả thật từ production builder.
function scoreWithMethod(
    method: MethodName,
    candidate: CandidateObservation,
    request: EvaluationRequest,
    halfLifeDays: number,
    productionFreshness: FreshnessFeatureReader,
): number {
    if (method === 'production-bucket') {
        return productionFreshness(
            toRecommendationCandidate(candidate.product),
            new Date(request.requestAtMs),
        );
    }
    if (method === 'exponential-decay')
        return exponentialDecayScore(candidate.ageDays, halfLifeDays);
    return 0;
}

// Tính seed-level metrics cho một method sau khi khóa half-life ở validation.
function evaluateMethod(
    requests: EvaluationRequest[],
    method: MethodName,
    halfLifeDays: number,
    productionFreshness: FreshnessFeatureReader,
): AggregateMetrics {
    const queries = measureQueries(requests, (candidate, request) =>
        scoreWithMethod(
            method,
            candidate,
            request,
            halfLifeDays,
            productionFreshness,
        ),
    );
    return aggregateQueryMetrics(requests, queries);
}

// Tính spread trên các seed độc lập thay vì chỉ báo một lần chạy thuận lợi.
function summarizeSpread(values: number[]): SpreadSummary {
    const sorted = [...values].sort((left, right) => left - right);
    const mean =
        values.length === 0
            ? 0
            : values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance =
        values.length < 2
            ? 0
            : values.reduce(
                  (sum, value) => sum + Math.pow(value - mean, 2),
                  0,
              ) / values.length;

    return {
        mean,
        standardDeviation: Math.sqrt(variance),
        minimum: sorted[0] ?? 0,
        maximum: sorted[sorted.length - 1] ?? 0,
    };
}

// Lấy phân vị bootstrap theo phương pháp nearest-rank để CI có cách tính xác định.
function percentile(sortedValues: number[], probability: number): number {
    if (sortedValues.length === 0) return 0;
    const index = Math.min(
        sortedValues.length - 1,
        Math.max(0, Math.ceil(probability * sortedValues.length) - 1),
    );
    return sortedValues[index] ?? 0;
}

// Bootstrap theo seed độc lập để không giả định các request dùng chung một catalog là độc lập thống kê.
function pairedBootstrapInterval(
    left: SeedMethodResult[],
    right: SeedMethodResult[],
    metric: 'ndcgAt10' | 'recallAt10',
    seed: number,
): PairedConfidenceInterval {
    const rightBySeed = new Map(right.map((result) => [result.seed, result]));
    const deltas = left.flatMap((leftResult) => {
        const rightResult = rightBySeed.get(leftResult.seed);
        if (!rightResult) return [];
        return [leftResult[metric] - rightResult[metric]];
    });
    if (deltas.length === 0) {
        return {
            meanDifference: 0,
            lower95: 0,
            upper95: 0,
            pairedSeedCount: 0,
        };
    }

    const random = createRandom(seed);
    const bootstrapMeans = new Array<number>(BOOTSTRAP_REPLICATES);
    for (let replicate = 0; replicate < BOOTSTRAP_REPLICATES; replicate += 1) {
        let sum = 0;
        for (let sample = 0; sample < deltas.length; sample += 1) {
            sum += deltas[Math.floor(random() * deltas.length)] ?? 0;
        }
        bootstrapMeans[replicate] = sum / deltas.length;
    }
    bootstrapMeans.sort((leftValue, rightValue) => leftValue - rightValue);

    return {
        meanDifference:
            deltas.reduce((sum, value) => sum + value, 0) / deltas.length,
        lower95: percentile(bootstrapMeans, 0.025),
        upper95: percentile(bootstrapMeans, 0.975),
        pairedSeedCount: deltas.length,
    };
}

// Tạo time-series summaries; catalog overlap là có chủ đích để item age tăng dần theo thời gian.
function summarizeSplits(
    requests: EvaluationRequest[],
): Record<EvaluationSplit, SplitCounts> {
    const result = {} as Record<EvaluationSplit, SplitCounts>;
    for (const split of ['train', 'validation', 'test'] as const) {
        const selected = requests.filter((request) => request.split === split);
        const sortedTimes = selected
            .map((request) => request.requestAtMs)
            .sort((a, b) => a - b);
        const impressions = selected.reduce(
            (sum, request) => sum + request.candidates.length,
            0,
        );
        const clicks = selected.reduce(
            (sum, request) =>
                sum +
                request.candidates.reduce(
                    (rowSum, candidate) => rowSum + candidate.clicked,
                    0,
                ),
            0,
        );
        result[split] = {
            requestCount: selected.length,
            candidateImpressions: impressions,
            clicks,
            firstRequestAt:
                sortedTimes[0] === undefined
                    ? null
                    : new Date(sortedTimes[0]).toISOString(),
            lastRequestAt:
                sortedTimes.at(-1) === undefined
                    ? null
                    : new Date(sortedTimes.at(-1)!).toISOString(),
        };
    }
    return result;
}

// Chạy nhiều seed, kiểm tra lưới H chỉ trên validation rồi giữ nguyên lựa chọn hòa khi chấm test.
function evaluateScenario(
    datasets: Map<number, ScenarioDataset>,
    productionFreshness: FreshnessFeatureReader,
): ScenarioResult {
    const validationBySeed = new Map<number, EvaluationRequest[]>();
    for (const [seed, dataset] of datasets) {
        validationBySeed.set(
            seed,
            dataset.requests.filter(
                (request) => request.split === 'validation',
            ),
        );
    }
    const tuning = tuneHalfLife(validationBySeed);
    const testByMethod = new Map<MethodName, SeedMethodResult[]>();

    for (const method of [
        'production-bucket',
        'exponential-decay',
        'no-freshness',
    ] as const) {
        testByMethod.set(method, []);
    }

    for (const [seed, dataset] of datasets) {
        const testRequests = dataset.requests.filter(
            (request) => request.split === 'test',
        );
        for (const method of [
            'production-bucket',
            'exponential-decay',
            'no-freshness',
        ] as const) {
            const aggregate = evaluateMethod(
                testRequests,
                method,
                tuning.selectedHalfLifeDays,
                productionFreshness,
            );
            testByMethod.get(method)!.push({
                seed,
                ...aggregate,
                ...(method === 'exponential-decay'
                    ? { selectedHalfLifeDays: tuning.selectedHalfLifeDays }
                    : {}),
            });
        }
    }

    const summaries = {} as ScenarioResult['testByMethod'];
    for (const method of [
        'production-bucket',
        'exponential-decay',
        'no-freshness',
    ] as const) {
        const results = testByMethod.get(method) ?? [];
        summaries[method] = {
            metrics: {
                ndcgAt10: summarizeSpread(
                    results.map((result) => result.ndcgAt10),
                ),
                recallAt10: summarizeSpread(
                    results.map((result) => result.recallAt10),
                ),
            },
            seeds: results,
        };
    }

    const seedResults = {
        bucket: testByMethod.get('production-bucket') ?? [],
        exponential: testByMethod.get('exponential-decay') ?? [],
        none: testByMethod.get('no-freshness') ?? [],
    };
    const pairedTestDifferences = {
        'bucket-minus-no-freshness': {
            ndcgAt10: pairedBootstrapInterval(
                seedResults.bucket,
                seedResults.none,
                'ndcgAt10',
                CONFIDENCE_SEED,
            ),
            recallAt10: pairedBootstrapInterval(
                seedResults.bucket,
                seedResults.none,
                'recallAt10',
                CONFIDENCE_SEED + 1,
            ),
        },
        'exponential-minus-bucket': {
            ndcgAt10: pairedBootstrapInterval(
                seedResults.exponential,
                seedResults.bucket,
                'ndcgAt10',
                CONFIDENCE_SEED + 2,
            ),
            recallAt10: pairedBootstrapInterval(
                seedResults.exponential,
                seedResults.bucket,
                'recallAt10',
                CONFIDENCE_SEED + 3,
            ),
        },
        'exponential-minus-no-freshness': {
            ndcgAt10: pairedBootstrapInterval(
                seedResults.exponential,
                seedResults.none,
                'ndcgAt10',
                CONFIDENCE_SEED + 4,
            ),
            recallAt10: pairedBootstrapInterval(
                seedResults.exponential,
                seedResults.none,
                'recallAt10',
                CONFIDENCE_SEED + 5,
            ),
        },
    };

    return {
        selectedHalfLifeDays: tuning.selectedHalfLifeDays,
        validationByHalfLife: tuning.validationByHalfLife,
        testByMethod: summaries,
        pairedTestDifferences,
    };
}

// In kết quả số học và metadata để người khác chạy lại được mà không nhầm synthetic với log thật.
function printReport(
    datasetsByScenario: Map<ScenarioName, Map<number, ScenarioDataset>>,
    results: Record<ScenarioName, ScenarioResult>,
): void {
    const counts = {} as Record<
        ScenarioName,
        Record<EvaluationSplit, SplitCounts>
    >;
    const events = {} as Record<
        ScenarioName,
        { impressions: number; clicks: number }
    >;
    for (const scenario of ['age-sensitive', 'age-neutral'] as const) {
        const scenarioDatasets = datasetsByScenario.get(scenario)!;
        const combinedRequests = [...scenarioDatasets.values()].flatMap(
            (dataset) => dataset.requests,
        );
        counts[scenario] = summarizeSplits(combinedRequests);
        events[scenario] = [...scenarioDatasets.values()].reduce(
            (sum, dataset) => ({
                impressions: sum.impressions + dataset.eventCounts.impressions,
                clicks: sum.clicks + dataset.eventCounts.clicks,
            }),
            { impressions: 0, clicks: 0 },
        );
    }

    const summary = {
        evaluator: 'criterion-6-freshness-synthetic-v1',
        cutoff: CUTOFF,
        seeds: SEEDS,
        requestsPerSeed: REQUESTS_PER_SEED,
        productsPerSeed: PRODUCTS_PER_SEED,
        candidatesPerRequest: CANDIDATES_PER_REQUEST,
        splits: { train: '0–59.9%', validation: '60–79.9%', test: '80–99.9%' },
        halfLifeGridDays: HALF_LIFE_GRID_DAYS,
        exponentialFloor: EXPONENTIAL_FLOOR,
        bootstrapReplicates: BOOTSTRAP_REPLICATES,
        dataCounts: counts,
        syntheticEvents: events,
        assumptions: {
            ageSensitive:
                'Click probability includes a linear novelty prior max(0, 1 - ageDays / 180), independently specified from the bucket/exponential scores.',
            ageNeutral:
                'Click probability excludes product age; category fit, brand fit, and latent product quality still affect outcomes.',
            noFreshness:
                'All candidates receive score 0; deterministic request-item hash breaks ties and represents a ranker with no age signal.',
            ageBoundary:
                'Products created after a request are excluded. Each request/user ID is unique across splits; product catalog overlap is intentional.',
            evaluator:
                'Feature-only NDCG@10 and Recall@10; no model training, exposure correction, or real user behavior is simulated.',
            halfLife:
                'All positive H values rank by the same age order in a freshness-only ranker. Validation NDCG cannot identify an optimal H; choosing the smallest H on a tie is only a deterministic representative, not tuning evidence.',
            uncertainty:
                'Paired bootstrap resamples the 12 independent synthetic seeds, not individual requests, because requests within a seed share a catalog.',
        },
        scenarios: results,
    };

    process.stdout.write('Criterion 6 freshness synthetic evaluator v1\n');
    process.stdout.write(
        'Test metrics below are averaged per seed; values are not real-user evidence.\n\n',
    );
    process.stdout.write(
        'Half-life note: validation NDCG ties across H because every positive H preserves the same age order; the selected H is not an estimated optimum.\n\n',
    );
    process.stdout.write(
        'Scenario       | Method            | H days | Test NDCG@10 mean ± SD | Test Recall@10 mean ± SD\n',
    );
    process.stdout.write(
        '---------------|-------------------|--------|------------------------|-------------------------\n',
    );
    for (const scenario of ['age-sensitive', 'age-neutral'] as const) {
        const result = results[scenario];
        for (const method of [
            'production-bucket',
            'exponential-decay',
            'no-freshness',
        ] as const) {
            const metrics = result.testByMethod[method].metrics;
            const halfLife =
                method === 'exponential-decay'
                    ? String(result.selectedHalfLifeDays)
                    : '—';
            process.stdout.write(
                `${scenario.padEnd(14)} | ${method.padEnd(17)} | ${halfLife.padStart(6)} | ` +
                    `${metrics.ndcgAt10.mean.toFixed(4)} ± ${metrics.ndcgAt10.standardDeviation.toFixed(4)}       | ` +
                    `${metrics.recallAt10.mean.toFixed(4)} ± ${metrics.recallAt10.standardDeviation.toFixed(4)}\n`,
            );
        }
    }
    process.stdout.write(
        '\nPaired 95% bootstrap intervals (method difference, same test requests):\n',
    );
    for (const scenario of ['age-sensitive', 'age-neutral'] as const) {
        process.stdout.write(
            `${scenario}: ${JSON.stringify(results[scenario].pairedTestDifferences)}\n`,
        );
    }
    process.stdout.write('\nFull deterministic report:\n');
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    process.stdout.write(
        '\nGiới hạn: dữ liệu nhãn age-sensitive cố ý giả định có ưu tiên sản phẩm mới; age-neutral giả định không có quan hệ tuổi. Kết quả chỉ kiểm tra hai thế giới giả lập và implementation/evaluator, không chứng minh công thức tốt hoặc tối ưu trên khách hàng thật.\n',
    );
}

// Chạy evaluator thuần offline với reference time cố định; sai cấu hình hoặc split rỗng làm tiến trình dừng rõ ràng.
function main(): void {
    const productionFreshness = createProductionFreshnessReader();
    const datasetsByScenario = new Map<
        ScenarioName,
        Map<number, ScenarioDataset>
    >();

    for (const scenario of ['age-sensitive', 'age-neutral'] as const) {
        const datasetsBySeed = new Map<number, ScenarioDataset>();
        for (const seed of SEEDS) {
            const catalog = createCatalog(seed);
            const rawRequests = createRawRequests(seed, catalog);
            const dataset = materializeScenario(rawRequests, scenario);
            if (
                dataset.requests.filter(
                    (request) => request.split === 'validation',
                ).length === 0 ||
                dataset.requests.filter((request) => request.split === 'test')
                    .length === 0
            ) {
                throw new Error(
                    'FRESHNESS_VALIDATION_AND_TEST_MUST_NOT_BE_EMPTY',
                );
            }
            datasetsBySeed.set(seed, dataset);
        }
        datasetsByScenario.set(scenario, datasetsBySeed);
    }

    const results = {
        'age-sensitive': evaluateScenario(
            datasetsByScenario.get('age-sensitive')!,
            productionFreshness,
        ),
        'age-neutral': evaluateScenario(
            datasetsByScenario.get('age-neutral')!,
            productionFreshness,
        ),
    } satisfies Record<ScenarioName, ScenarioResult>;

    printReport(datasetsByScenario, results);
}

main();
