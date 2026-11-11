// File này so sánh các công thức sessionContext trên dữ liệu synthetic có seed cố định.
// Script gọi feature builder production cho công thức tuyến tính, nhưng không huấn luyện
// model AI và không truy cập dữ liệu người mua thật; các baseline chỉ thuộc evaluator.

import { ConfigService } from '@nestjs/config';
import { RecommendationRuleService } from '@/modules/profiles/application/services/rules/recommendation-rule.service';
import type { SessionContext } from '@/modules/profiles/application/types/profile.types';
import { RankingFeatureService } from '@/modules/recommendation/application/services/ranking/features/ranking-feature.service';
import type { RecommendationCandidate } from '@/modules/recommendation/application/types/ranking/ranking.types';

type ScenarioName = 'stable-interest' | 'switching-interest';
type EvaluationSplit = 'development' | 'validation' | 'test';

interface Intent {
    categoryId: string;
    brandId: string;
}

interface SyntheticCandidate {
    candidate: RecommendationCandidate;
    categoryId: string;
    brandId: string;
    productId: string;
}

interface SyntheticRequest {
    context: SessionContext;
    categoryAgeHours: Map<string, number>;
    brandAgeHours: Map<string, number>;
    relevance: Uint8Array;
    tieBreakers: Float64Array;
    split: EvaluationSplit;
}

interface RankingMetrics {
    ndcg: number;
    recall: number;
    requestCount: number;
    recallRequestCount: number;
}

interface FormulaMetrics {
    validation: RankingMetrics;
    test: RankingMetrics;
    halfLifeHours?: number;
}

const SEED = 20261111;
const REQUESTS_PER_SCENARIO = 1200;
const CUTOFF = 10;
const HALF_LIFE_GRID_HOURS = [0.5, 1, 2, 4, 8, 12, 24, 48];
const CATEGORY_COUNT = 16;
const BRAND_COUNT = 12;
const REFERENCE_TIME = new Date('2026-11-11T00:00:00.000Z');
const DEVELOPMENT_END = Math.floor(REQUESTS_PER_SCENARIO * 0.6);
const VALIDATION_END = Math.floor(REQUESTS_PER_SCENARIO * 0.8);

// PRNG tuyến tính cho phép tái tạo cùng ý định, lịch sử và nhãn ở mọi lần chạy.
function createRandomGenerator(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4_294_967_296;
    };
}

// Băm request và sản phẩm thành khóa phá hòa ổn định, tránh ưu tiên ngầm theo ID catalog.
function stableTieBreaker(value: string): number {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash / 4_294_967_296;
}

// Tạo danh mục cân bằng gồm đủ mọi cặp category-brand để công thức nào cũng xếp cùng candidate pool.
function createCandidateCatalog(): SyntheticCandidate[] {
    const catalog: SyntheticCandidate[] = [];
    for (let category = 0; category < CATEGORY_COUNT; category += 1) {
        for (let brand = 0; brand < BRAND_COUNT; brand += 1) {
            const categoryId = 'category-' + category;
            const brandId = 'brand-' + brand;
            const productId = categoryId + '-' + brandId;
            catalog.push({
                candidate: {
                    product: {
                        productId,
                        categoryId,
                        brandId,
                        totalSold: 0,
                        createdAt: REFERENCE_TIME,
                        ratingAvg: null,
                        reviewCount: 0,
                        isInStock: true,
                    } as RecommendationCandidate['product'],
                    sources: new Set(),
                    contributions: [],
                },
                categoryId,
                brandId,
                productId,
            });
        }
    }
    return catalog;
}

// Tạo một cặp ý định khác nhau để kịch bản chuyển ý có thể chứa lịch sử cũ và tín hiệu mới.
function createIntentPair(random: () => number): {
    current: Intent;
    previous: Intent;
} {
    const currentCategory = Math.floor(random() * CATEGORY_COUNT);
    const currentBrand = Math.floor(random() * BRAND_COUNT);
    let previousCategory = Math.floor(random() * CATEGORY_COUNT);
    let previousBrand = Math.floor(random() * BRAND_COUNT);
    if (previousCategory === currentCategory) {
        previousCategory = (previousCategory + 1) % CATEGORY_COUNT;
    }
    if (previousBrand === currentBrand) {
        previousBrand = (previousBrand + 1) % BRAND_COUNT;
    }
    return {
        current: {
            categoryId: 'category-' + currentCategory,
            brandId: 'brand-' + currentBrand,
        },
        previous: {
            categoryId: 'category-' + previousCategory,
            brandId: 'brand-' + previousBrand,
        },
    };
}

// Chọn một khóa nhiễu khác ý định nguồn để synthetic data không biến thành lịch sử hoàn hảo.
function chooseNoisyKey(
    prefix: 'category' | 'brand',
    sourceKey: string,
    count: number,
    random: () => number,
): string {
    let value = Math.floor(random() * count);
    const sourceValue = Number(sourceKey.slice(prefix.length + 1));
    if (value === sourceValue) value = (value + 1) % count;
    return prefix + '-' + value;
}

// Dựng lịch sử mới nhất-trước, đồng thời giữ tuổi mỗi khóa riêng để exponential baseline dùng timestamp thật của synthetic log.
function createSessionHistory(
    requestIndex: number,
    scenario: ScenarioName,
    intent: { current: Intent; previous: Intent },
    random: () => number,
): {
    context: SessionContext;
    categoryAgeHours: Map<string, number>;
    brandAgeHours: Map<string, number>;
} {
    const eventCount = 8 + Math.floor(random() * 7);
    const requestTime = REFERENCE_TIME.getTime() + requestIndex * 60_000;
    const recentCategoryIds: string[] = [];
    const recentBrandIds: string[] = [];
    const categoryAgeHours = new Map<string, number>();
    const brandAgeHours = new Map<string, number>();
    let ageMinutes = 0;
    let latestEventTime = requestTime;

    for (let position = 0; position < eventCount; position += 1) {
        ageMinutes += 15 + random() * 75;
        // SessionContextService cập nhật intentUpdatedAt bằng thời điểm event mới nhất, không phải thời điểm request đọc context.
        if (position === 0) latestEventTime = requestTime - ageMinutes * 60_000;
        const relativePosition = position / Math.max(1, eventCount - 1);
        const currentIntentProbability =
            scenario === 'stable-interest'
                ? 0.82
                : 0.9 - 0.75 * relativePosition;
        const sourceIntent =
            random() < currentIntentProbability
                ? intent.current
                : intent.previous;
        const categoryId =
            random() < 0.12
                ? chooseNoisyKey(
                      'category',
                      sourceIntent.categoryId,
                      CATEGORY_COUNT,
                      random,
                  )
                : sourceIntent.categoryId;
        const brandId =
            random() < 0.12
                ? chooseNoisyKey(
                      'brand',
                      sourceIntent.brandId,
                      BRAND_COUNT,
                      random,
                  )
                : sourceIntent.brandId;
        const eventAgeHours = ageMinutes / 60;

        // Vị trí đầu lưu lần xuất hiện mới nhất của khóa; khóa lặp không kéo dài độ dài danh sách.
        if (!recentCategoryIds.includes(categoryId)) {
            recentCategoryIds.push(categoryId);
            categoryAgeHours.set(categoryId, eventAgeHours);
        }
        if (!recentBrandIds.includes(brandId)) {
            recentBrandIds.push(brandId);
            brandAgeHours.set(brandId, eventAgeHours);
        }
    }

    return {
        context: {
            sessionId: scenario + '-' + requestIndex,
            recentProductIds: [],
            recentCategoryIds,
            recentBrandIds,
            currentProductId: null,
            currentCategoryId: null,
            latestQuery: null,
            cartProductIds: [],
            intentUpdatedAt: new Date(latestEventTime).toISOString(),
            version: 1,
        },
        categoryAgeHours,
        brandAgeHours,
    };
}

// Sinh click theo ý định ẩn hiện tại, độc lập với điểm của ba công thức đang đem ra so.
function createRelevanceLabels(
    catalog: SyntheticCandidate[],
    currentIntent: Intent,
    random: () => number,
): Uint8Array {
    return Uint8Array.from(
        catalog.map(({ categoryId, brandId }) => {
            const matches =
                Number(categoryId === currentIntent.categoryId) +
                Number(brandId === currentIntent.brandId);
            const relevance = matches / 2;
            const clickProbability = 0.015 + 0.85 * relevance;
            return Number(random() < clickProbability);
        }),
    );
}

// Tạo một request synthetic và gán split theo thời gian để tham số chỉ được chọn trước test.
function createSyntheticRequest(
    requestIndex: number,
    scenario: ScenarioName,
    catalog: SyntheticCandidate[],
    random: () => number,
): SyntheticRequest {
    const intent = createIntentPair(random);
    const history = createSessionHistory(
        requestIndex,
        scenario,
        intent,
        random,
    );
    const relevance = createRelevanceLabels(catalog, intent.current, random);
    const tieBreakers = Float64Array.from(
        catalog.map(({ productId }) =>
            stableTieBreaker(
                SEED + ':' + scenario + ':' + requestIndex + ':' + productId,
            ),
        ),
    );
    const split: EvaluationSplit =
        requestIndex < DEVELOPMENT_END
            ? 'development'
            : requestIndex < VALIDATION_END
              ? 'validation'
              : 'test';

    return {
        context: history.context,
        categoryAgeHours: history.categoryAgeHours,
        brandAgeHours: history.brandAgeHours,
        relevance,
        tieBreakers,
        split,
    };
}

// Sinh cohort ổn định và chuyển ý bằng các seed tách biệt nhưng xác định trước.
function createScenarioRequests(
    scenario: ScenarioName,
    catalog: SyntheticCandidate[],
): SyntheticRequest[] {
    const scenarioSeed =
        scenario === 'stable-interest' ? SEED : SEED + 1_000_003;
    const random = createRandomGenerator(scenarioSeed);
    return Array.from({ length: REQUESTS_PER_SCENARIO }, (_, requestIndex) =>
        createSyntheticRequest(requestIndex, scenario, catalog, random),
    );
}

// Baseline nhị phân chỉ hỏi sản phẩm có từng xuất hiện trong category hoặc brand của phiên hay không.
function binaryMatchScore(
    candidate: SyntheticCandidate,
    context: SessionContext,
): number {
    const categoryMatch = context.recentCategoryIds.includes(
        candidate.categoryId,
    );
    const brandMatch = context.recentBrandIds.includes(candidate.brandId);
    return (Number(categoryMatch) + Number(brandMatch)) / 2;
}

// Exponential baseline giảm đóng góp theo tuổi tín hiệu; half-life được chọn riêng trên validation.
function exponentialTimeScore(
    candidate: SyntheticCandidate,
    request: SyntheticRequest,
    halfLifeHours: number,
): number {
    const categoryAge = request.categoryAgeHours.get(candidate.categoryId);
    const brandAge = request.brandAgeHours.get(candidate.brandId);
    const categoryScore =
        categoryAge === undefined
            ? 0
            : Math.pow(0.5, categoryAge / halfLifeHours);
    const brandScore =
        brandAge === undefined ? 0 : Math.pow(0.5, brandAge / halfLifeHours);
    return (categoryScore + brandScore) / 2;
}

// Tính NDCG@K và Recall@K theo từng request; request không có click được giữ trong NDCG nhưng không làm Recall chia cho 0.
function measureRanking(
    requests: SyntheticRequest[],
    catalog: SyntheticCandidate[],
    score: (candidate: SyntheticCandidate, request: SyntheticRequest) => number,
): RankingMetrics {
    let ndcgTotal = 0;
    let recallTotal = 0;
    let recallRequestCount = 0;

    for (const request of requests) {
        const candidateScores = catalog.map((candidate) =>
            score(candidate, request),
        );
        const rankedIndices = catalog.map((_, index) => index);
        rankedIndices.sort((leftIndex, rightIndex) => {
            return (
                (candidateScores[rightIndex] ?? 0) -
                    (candidateScores[leftIndex] ?? 0) ||
                (request.tieBreakers[rightIndex] ?? 0) -
                    (request.tieBreakers[leftIndex] ?? 0)
            );
        });

        let dcg = 0;
        let hits = 0;
        let relevantCount = 0;
        for (const label of request.relevance) relevantCount += label;
        for (let rank = 0; rank < CUTOFF; rank += 1) {
            const candidateIndex = rankedIndices[rank];
            // Pool chuẩn luôn lớn hơn K; fallback giữ evaluator an toàn nếu K đổi vượt quá số candidate.
            if (candidateIndex === undefined) continue;
            const label = request.relevance[candidateIndex] ?? 0;
            if (label) {
                dcg += 1 / Math.log2(rank + 2);
                hits += 1;
            }
        }

        const idealCount = Math.min(relevantCount, CUTOFF);
        let idealDcg = 0;
        for (let rank = 0; rank < idealCount; rank += 1) {
            idealDcg += 1 / Math.log2(rank + 2);
        }
        ndcgTotal += idealDcg === 0 ? 0 : dcg / idealDcg;
        if (relevantCount > 0) {
            recallTotal += hits / relevantCount;
            recallRequestCount += 1;
        }
    }

    return {
        ndcg: requests.length === 0 ? 0 : ndcgTotal / requests.length,
        recall: recallRequestCount === 0 ? 0 : recallTotal / recallRequestCount,
        requestCount: requests.length,
        recallRequestCount,
    };
}

// Tách request theo nhãn split mà không thay đổi candidate hoặc ground-truth click đã sinh.
function selectSplit(
    requests: SyntheticRequest[],
    split: EvaluationSplit,
): SyntheticRequest[] {
    return requests.filter((request) => request.split === split);
}

// Chọn half-life có NDCG validation cao nhất; test không được đọc trong bước chọn tham số.
function selectHalfLife(
    validationRequests: SyntheticRequest[],
    catalog: SyntheticCandidate[],
): { halfLifeHours: number; metrics: RankingMetrics } {
    const candidates = HALF_LIFE_GRID_HOURS.map((halfLifeHours) => ({
        halfLifeHours,
        metrics: measureRanking(
            validationRequests,
            catalog,
            (candidate, request) =>
                exponentialTimeScore(candidate, request, halfLifeHours),
        ),
    }));
    candidates.sort(
        (left, right) =>
            right.metrics.ndcg - left.metrics.ndcg ||
            left.halfLifeHours - right.halfLifeHours,
    );
    const selected = candidates[0];
    if (!selected) throw new Error('HALF_LIFE_GRID_MUST_NOT_BE_EMPTY');
    return selected;
}

// So sánh ba phương án trên cùng request và candidate pool.
// Half-life nhận từ validation gộp để không cho baseline biết trước mỗi request thuộc cohort nào.
// Điểm tuyến tính luôn lấy qua feature builder production, còn exponential là đối chứng có timestamp.
function evaluateScenario(
    requests: SyntheticRequest[],
    catalog: SyntheticCandidate[],
    features: RankingFeatureService,
    halfLifeHours: number,
): Record<string, FormulaMetrics> {
    const validation = selectSplit(requests, 'validation');
    const test = selectSplit(requests, 'test');
    const emptyPreferences: never[] = [];

    const binaryValidation = measureRanking(
        validation,
        catalog,
        (candidate, request) => binaryMatchScore(candidate, request.context),
    );
    const binaryTest = measureRanking(test, catalog, (candidate, request) =>
        binaryMatchScore(candidate, request.context),
    );
    const linearValidation = measureRanking(
        validation,
        catalog,
        (candidate, request) =>
            features.build(
                candidate.candidate,
                emptyPreferences,
                emptyPreferences,
                emptyPreferences,
                request.context,
                undefined,
                REFERENCE_TIME,
            ).sessionContext,
    );
    const linearTest = measureRanking(
        test,
        catalog,
        (candidate, request) =>
            features.build(
                candidate.candidate,
                emptyPreferences,
                emptyPreferences,
                emptyPreferences,
                request.context,
                undefined,
                REFERENCE_TIME,
            ).sessionContext,
    );
    const exponentialValidation = measureRanking(
        validation,
        catalog,
        (candidate, request) =>
            exponentialTimeScore(candidate, request, halfLifeHours),
    );
    const exponentialTest = measureRanking(
        test,
        catalog,
        (candidate, request) =>
            exponentialTimeScore(candidate, request, halfLifeHours),
    );

    return {
        'Binary match': {
            validation: binaryValidation,
            test: binaryTest,
        },
        'Production linear position': {
            validation: linearValidation,
            test: linearTest,
        },
        'Exponential time decay': {
            validation: exponentialValidation,
            test: exponentialTest,
            halfLifeHours,
        },
    };
}

// In bảng dễ đọc và JSON chi tiết, đồng thời ghi lại half-life đã chọn trên validation gộp.
function printReport(
    results: Record<ScenarioName, Record<string, FormulaMetrics>>,
    pooledHalfLife: { halfLifeHours: number; metrics: RankingMetrics },
): void {
    process.stdout.write(
        'Synthetic sessionContext evaluation — seed ' +
            SEED +
            '\n' +
            'Candidate pool: ' +
            CATEGORY_COUNT * BRAND_COUNT +
            ' products; requests/cohort: ' +
            REQUESTS_PER_SCENARIO +
            '; split: development/validation/test = 60%/20%/20%; K=' +
            CUTOFF +
            '\n' +
            'Shared half-life selected on pooled validation: ' +
            pooledHalfLife.halfLifeHours +
            ' hours.\n' +
            'Scores are feature-only. Click labels use hidden current intent; no AI model is trained.\n\n',
    );
    process.stdout.write(
        'Scenario             | Formula                    | H (hours) | Val NDCG@10 | Test NDCG@10 | Test Recall@10\n' +
            '---------------------|----------------------------|-----------|-------------|--------------|---------------\n',
    );

    for (const scenario of ['stable-interest', 'switching-interest'] as const) {
        for (const [formula, metrics] of Object.entries(results[scenario])) {
            const halfLife = metrics.halfLifeHours?.toString() ?? '—';
            process.stdout.write(
                scenario.padEnd(20) +
                    ' | ' +
                    formula.padEnd(26) +
                    ' | ' +
                    halfLife.padStart(9) +
                    ' | ' +
                    (metrics.validation?.ndcg.toFixed(4) ?? '—').padStart(11) +
                    ' | ' +
                    metrics.test.ndcg.toFixed(4).padStart(12) +
                    ' | ' +
                    metrics.test.recall.toFixed(4).padStart(13) +
                    '\n',
            );
        }
    }

    process.stdout.write(
        '\nGiới hạn: số liệu synthetic kiểm tra hành vi evaluator theo giả định đã khai báo, không chứng minh hiệu quả với người dùng thật.\n' +
            'JSON chi tiết:\n' +
            JSON.stringify(
                {
                    seed: SEED,
                    candidateCount: CATEGORY_COUNT * BRAND_COUNT,
                    requestsPerScenario: REQUESTS_PER_SCENARIO,
                    split: {
                        development: DEVELOPMENT_END,
                        validation: VALIDATION_END - DEVELOPMENT_END,
                        test: REQUESTS_PER_SCENARIO - VALIDATION_END,
                    },
                    cutoff: CUTOFF,
                    halfLifeGridHours: HALF_LIFE_GRID_HOURS,
                    pooledValidation: {
                        selectedHalfLifeHours: pooledHalfLife.halfLifeHours,
                        ndcg: pooledHalfLife.metrics.ndcg,
                        requestCount: pooledHalfLife.metrics.requestCount,
                    },
                    results,
                },
                null,
                2,
            ) +
            '\n',
    );
}

// Chạy evaluator độc lập với service đang phục vụ; cấu hình còn lại dùng default của rule service.
function main(): void {
    const config = {
        get: (_key: string, fallback?: string) => fallback,
    } as ConfigService;
    const featureService = new RankingFeatureService(
        new RecommendationRuleService(config),
    );
    const catalog = createCandidateCatalog();
    const stableRequests = createScenarioRequests('stable-interest', catalog);
    const switchingRequests = createScenarioRequests(
        'switching-interest',
        catalog,
    );
    // Cohort label is only for analysis, not a feature available to ranking; tune one shared H on their pooled validation requests.
    const pooledValidation = [
        ...selectSplit(stableRequests, 'validation'),
        ...selectSplit(switchingRequests, 'validation'),
    ];
    const pooledHalfLife = selectHalfLife(pooledValidation, catalog);
    const results = {
        'stable-interest': evaluateScenario(
            stableRequests,
            catalog,
            featureService,
            pooledHalfLife.halfLifeHours,
        ),
        'switching-interest': evaluateScenario(
            switchingRequests,
            catalog,
            featureService,
            pooledHalfLife.halfLifeHours,
        ),
    } satisfies Record<ScenarioName, Record<string, FormulaMetrics>>;
    printReport(results, pooledHalfLife);
}

main();
