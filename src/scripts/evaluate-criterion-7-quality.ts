// Script này so sánh feature quality production với baseline rating trên synthetic fixture có seed.
// Nó chỉ kiểm tra một giả định mô phỏng, không đọc log khách hàng, không train LambdaRank và không chọn công thức tối ưu toàn cục.

import { ConfigService } from '@nestjs/config';
import type { PreferenceValue } from '@/modules/profiles/application/types/profile.types';
import { RecommendationRuleService } from '@/modules/profiles/application/services/rules/recommendation-rule.service';
import { RankingFeatureService } from '@/modules/recommendation/application/services/ranking/features/ranking-feature.service';
import type { RecommendationCandidate } from '@/modules/recommendation/application/types/ranking/ranking.types';

type SplitName = 'train' | 'validation' | 'test';
type MethodName =
    'Project quality' | 'Mean rating' | 'Empirical Bayes' | 'Wilson 95%';
type RandomSource = () => number;

interface RatingEvent {
    occurredAt: number;
    stars: number;
}

interface RatingSnapshot {
    ratingAvg: number | null;
    reviewCount: number;
    positiveReviewCount: number;
}

interface SyntheticProduct {
    productId: string;
    latentQuality: number;
    ratingEvents: RatingEvent[];
    snapshots: RatingSnapshot[];
    candidate: RecommendationCandidate;
}

interface RequestCandidate {
    product: SyntheticProduct;
    snapshot: RatingSnapshot;
    relevance: number;
    tieBreaker: number;
    projectQualityScore: number;
}

interface SyntheticRequest {
    requestId: string;
    requestAt: number;
    split: SplitName;
    candidates: RequestCandidate[];
}

interface RankingMetrics {
    ndcgAt10: number;
    recallAt10: number;
    requestCount: number;
    requestsWithPositive: number;
    requestPositiveCoverage: number;
    ratedCandidateCoverage: number;
}

interface SeedMethodResult {
    seed: number;
    validationNdcgAt10: number;
    test: RankingMetrics;
    selectedPriorStrength?: number;
}

interface SeedSummary {
    mean: number;
    standardDeviation: number;
    minimum: number;
    maximum: number;
}

interface MethodSummary {
    ndcgAt10: SeedSummary;
    recallAt10: SeedSummary;
    requestPositiveCoverage: SeedSummary;
    ratedCandidateCoverage: SeedSummary;
}

interface MethodResults {
    summary: MethodSummary;
    perSeed: SeedMethodResult[];
    pairedDeltaVsProject?: PairedComparison;
}

interface PairedMetricDelta {
    mean: number;
    confidenceInterval95: { lower: number; upper: number };
}

interface PairedSeedDelta {
    seed: number;
    ndcgAt10: number;
    recallAt10: number;
}

interface PairedComparison {
    ndcgAt10: PairedMetricDelta;
    recallAt10: PairedMetricDelta;
    perSeed: PairedSeedDelta[];
}

const SEED_START = 101;
const SEED_COUNT = 20;
const PRODUCT_COUNT = 160;
const REQUEST_COUNT = 400;
const CANDIDATES_PER_REQUEST = 80;
const TRAIN_REQUEST_COUNT = Math.floor(REQUEST_COUNT * 0.6);
const VALIDATION_END = Math.floor(REQUEST_COUNT * 0.8);
const CUTOFF = 10;
const PRIOR_STRENGTH_GRID = [1, 2, 5, 10, 20, 50, 100];
const WILSON_Z_95 = 1.96;
const BOOTSTRAP_SEED = 0x7c51a39d;
const BOOTSTRAP_RESAMPLE_COUNT = 10_000;
const DAY_MS = 86_400_000;
const REFERENCE_START = Date.parse('2025-01-01T00:00:00.000Z');
const REVIEW_HORIZON_DAYS = REQUEST_COUNT + 60;

// Tạo bộ sinh giả ngẫu nhiên xác định để một seed luôn tái tạo đúng catalog, review và candidate sample.
function createRandomGenerator(seed: number): RandomSource {
    let state = seed >>> 0;
    return () => {
        state += 0x6d2b79f5;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
    };
}

// Lấy nhiễu chuẩn độc lập để rating quan sát được dao động quanh chất lượng tiềm ẩn của sản phẩm.
function normalNoise(random: RandomSource): number {
    const first = Math.max(random(), Number.EPSILON);
    const second = random();
    return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

// Chặn rating và xác suất trong miền hợp lệ của thang sao và nhãn nhị phân.
function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, value));
}

// Băm ID thành khóa hòa ổn định để tie không thừa hưởng thứ tự ban đầu của mảng.
function stableTieBreaker(value: string): number {
    let hash = 2_166_136_261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16_777_619) >>> 0;
    }
    return hash / 4_294_967_296;
}

// Tạo một catalog có chất lượng tiềm ẩn và review đến rải theo thời gian; số review độc lập chất lượng để tránh nhãn bị lấy từ feature.
function createProducts(seed: number): SyntheticProduct[] {
    const random = createRandomGenerator(seed ^ 0x71a9c31d);
    const reviewRandom = createRandomGenerator(seed ^ 0x3d0f4b27);
    return Array.from({ length: PRODUCT_COUNT }, (_, index) => {
        const productId = `quality-product-${String(index + 1).padStart(4, '0')}`;
        const latentQuality = 2 + random() * 2.8;
        const maximumReviews =
            random() < 0.08 ? 0 : 1 + Math.floor(Math.pow(random(), 2.2) * 120);
        const ratingEvents = Array.from(
            { length: maximumReviews },
            (): RatingEvent => ({
                occurredAt:
                    REFERENCE_START + random() * REVIEW_HORIZON_DAYS * DAY_MS,
                stars: Math.round(
                    clamp(
                        latentQuality + normalNoise(reviewRandom) * 0.85,
                        1,
                        5,
                    ),
                ),
            }),
        ).sort((left, right) => left.occurredAt - right.occurredAt);
        const candidate: RecommendationCandidate = {
            product: {
                productId,
                name: productId,
                slug: productId,
                imageUrl: null,
                categoryId: null,
                brandId: null,
                sellerShopId: null,
                minPrice: '1',
                maxPrice: '1',
                ratingAvg: null,
                reviewCount: 0,
                totalSold: 0,
                status: 'ACTIVE',
                isInStock: true,
                createdAt: new Date(REFERENCE_START),
                updatedAt: new Date(REFERENCE_START),
                catalogVersion: 'synthetic-quality-v1',
                shortDescription: null,
                description: null,
                brandName: null,
                categoryPath: null,
                semanticAttributes: [],
                contentHash: null,
                embeddingStatus: 'NOT_REQUIRED',
                embeddingModelVersion: null,
                embeddingDimensions: null,
            },
            sources: new Set(),
            contributions: [],
        };
        return {
            productId,
            latentQuality,
            ratingEvents,
            snapshots: [],
            candidate,
        };
    });
}

// Tạo snapshot tại mỗi request bằng một con trỏ tăng dần, không cho review tương lai lọt vào feature lịch sử.
function buildRatingSnapshots(products: SyntheticProduct[]): void {
    const requestTimes = Array.from(
        { length: REQUEST_COUNT },
        (_, index) => REFERENCE_START + index * DAY_MS,
    );

    for (const product of products) {
        let eventIndex = 0;
        let ratingSum = 0;
        let positiveReviewCount = 0;
        product.snapshots = requestTimes.map((requestAt) => {
            // Chỉ thêm review đã tồn tại tại thời điểm request; cùng snapshot dùng cho mọi phương pháp xếp hạng.
            while (
                product.ratingEvents[eventIndex] &&
                product.ratingEvents[eventIndex]!.occurredAt <= requestAt
            ) {
                const event = product.ratingEvents[eventIndex]!;
                ratingSum += event.stars;
                if (event.stars >= 4) positiveReviewCount += 1;
                eventIndex += 1;
            }
            const reviewCount = eventIndex;
            return {
                ratingAvg: reviewCount > 0 ? ratingSum / reviewCount : null,
                reviewCount,
                positiveReviewCount,
            };
        });
    }
}

// Lấy candidate sample không lặp bằng RNG riêng; tất cả phương pháp sau đó dùng đúng sample và cùng nhãn.
function sampleCandidateIndices(
    productCount: number,
    sampleSize: number,
    random: RandomSource,
): number[] {
    const indices = Array.from({ length: productCount }, (_, index) => index);
    for (let index = 0; index < sampleSize; index += 1) {
        const swapIndex = index + Math.floor(random() * (productCount - index));
        [indices[index], indices[swapIndex]] = [
            indices[swapIndex]!,
            indices[index]!,
        ];
    }
    return indices.slice(0, sampleSize);
}

// Sinh request theo thứ tự thời gian; outcome click dùng RNG riêng và chỉ phụ thuộc latent quality, không phụ thuộc formula/features.
function createRequests(
    seed: number,
    products: SyntheticProduct[],
    features: RankingFeatureService,
): SyntheticRequest[] {
    const noPreferences: PreferenceValue[] = [];
    const preferenceLookup = features.createPreferenceLookup(
        noPreferences,
        noPreferences,
        noPreferences,
    );

    return Array.from({ length: REQUEST_COUNT }, (_, requestIndex) => {
        const requestId = `quality-request-${String(requestIndex + 1).padStart(4, '0')}`;
        const requestAt = REFERENCE_START + requestIndex * DAY_MS;
        const requestRandom = createRandomGenerator(
            seed ^ Math.imul(requestIndex + 1, 0x45d9f3b),
        );
        const outcomeRandom = createRandomGenerator(
            seed ^ Math.imul(requestIndex + 1, 0x119de1f3),
        );
        const productIndices = sampleCandidateIndices(
            products.length,
            CANDIDATES_PER_REQUEST,
            requestRandom,
        );
        const split: SplitName =
            requestIndex < TRAIN_REQUEST_COUNT
                ? 'train'
                : requestIndex < VALIDATION_END
                  ? 'validation'
                  : 'test';
        const candidates = productIndices.map((productIndex) => {
            const product = products[productIndex];
            if (!product) throw new Error('SYNTHETIC_PRODUCT_MISSING');
            const snapshot = product.snapshots[requestIndex];
            if (!snapshot) throw new Error('RATING_SNAPSHOT_MISSING');
            const normalizedTruth = (product.latentQuality - 1) / 4;
            const clickProbability = 0.03 + 0.2 * normalizedTruth;
            const relevance = Number(outcomeRandom() < clickProbability);
            const candidate: RecommendationCandidate = {
                ...product.candidate,
                product: {
                    ...product.candidate.product,
                    ratingAvg:
                        snapshot.ratingAvg === null
                            ? null
                            : snapshot.ratingAvg.toFixed(6),
                    reviewCount: snapshot.reviewCount,
                    isInStock: true,
                },
            };
            const projectQualityScore = features.build(
                candidate,
                noPreferences,
                noPreferences,
                noPreferences,
                null,
                preferenceLookup,
                new Date(requestAt),
            ).quality;
            return {
                product,
                snapshot,
                relevance,
                tieBreaker: stableTieBreaker(
                    requestId + ':' + product.productId,
                ),
                projectQualityScore,
            };
        });
        return { requestId, requestAt, split, candidates };
    });
}

// Ước lượng prior mean từ snapshot cuối train; validation/test không được ảnh hưởng mức rating nền.
function estimateTrainingPrior(products: SyntheticProduct[]): number {
    const trainingSnapshotIndex = TRAIN_REQUEST_COUNT - 1;
    let sum = 0;
    let count = 0;
    for (const product of products) {
        const snapshot = product.snapshots[trainingSnapshotIndex];
        if (!snapshot || snapshot.ratingAvg === null) continue;
        sum += snapshot.ratingAvg * snapshot.reviewCount;
        count += snapshot.reviewCount;
    }
    return count > 0 ? sum / count : 3.5;
}

// Chọn tham số chỉ theo NDCG@10 của validation; ties ưu tiên prior yếu hơn để tránh làm mượt quá mức.
function selectPriorStrength(
    validationRequests: SyntheticRequest[],
    priorMean: number,
): { strength: number; metrics: RankingMetrics } {
    const candidates = PRIOR_STRENGTH_GRID.map((strength) => ({
        strength,
        metrics: measureRanking(validationRequests, 'Empirical Bayes', {
            priorMean,
            priorStrength: strength,
        }),
    }));
    candidates.sort(
        (left, right) =>
            right.metrics.ndcgAt10 - left.metrics.ndcgAt10 ||
            left.strength - right.strength,
    );
    const selected = candidates[0];
    if (!selected) throw new Error('PRIOR_STRENGTH_GRID_MUST_NOT_BE_EMPTY');
    return selected;
}

// Tính score cho một item theo đúng baseline; Wilson chỉ dùng synthetic positiveCount, không suy diễn từ average rating.
function scoreCandidate(
    candidate: RequestCandidate,
    method: MethodName,
    priorMean: number,
    priorStrength: number,
): number {
    const { ratingAvg, reviewCount, positiveReviewCount } = candidate.snapshot;
    if (method === 'Project quality') return candidate.projectQualityScore;
    if (method === 'Mean rating') return (ratingAvg ?? 0) / 5;
    if (method === 'Empirical Bayes') {
        const observedMean = ratingAvg ?? priorMean;
        return clamp(
            (reviewCount * observedMean + priorStrength * priorMean) /
                (reviewCount + priorStrength) /
                5,
            0,
            1,
        );
    }

    if (reviewCount === 0) return 0;
    const positiveRate = positiveReviewCount / reviewCount;
    const zSquared = WILSON_Z_95 ** 2;
    const denominator = 1 + zSquared / reviewCount;
    const center = positiveRate + zSquared / (2 * reviewCount);
    const radius =
        WILSON_Z_95 *
        Math.sqrt(
            (positiveRate * (1 - positiveRate) + zSquared / (4 * reviewCount)) /
                reviewCount,
        );
    return clamp((center - radius) / denominator, 0, 1);
}

// Đo NDCG/Recall macro theo request; query không positive vẫn đóng góp 0 NDCG nhưng không làm Recall chia cho 0.
function measureRanking(
    requests: SyntheticRequest[],
    method: MethodName,
    prior: { priorMean: number; priorStrength: number },
): RankingMetrics {
    let ndcgTotal = 0;
    let recallTotal = 0;
    let requestsWithPositive = 0;
    let ratedCandidateCount = 0;
    let candidateCount = 0;

    for (const request of requests) {
        const ranked = request.candidates
            .map((candidate) => ({
                candidate,
                score: scoreCandidate(
                    candidate,
                    method,
                    prior.priorMean,
                    prior.priorStrength,
                ),
            }))
            .sort(
                (left, right) =>
                    right.score - left.score ||
                    right.candidate.tieBreaker - left.candidate.tieBreaker ||
                    left.candidate.product.productId.localeCompare(
                        right.candidate.product.productId,
                    ),
            );
        const relevantCount = request.candidates.reduce(
            (sum, candidate) => sum + candidate.relevance,
            0,
        );
        const idealLength = Math.min(relevantCount, CUTOFF);
        let idealDcg = 0;
        for (let rank = 0; rank < idealLength; rank += 1) {
            idealDcg += 1 / Math.log2(rank + 2);
        }

        let dcg = 0;
        let hits = 0;
        for (let rank = 0; rank < CUTOFF; rank += 1) {
            const item = ranked[rank];
            if (!item) continue;
            if (item.candidate.relevance === 1) {
                dcg += 1 / Math.log2(rank + 2);
                hits += 1;
            }
        }
        ndcgTotal += idealDcg > 0 ? dcg / idealDcg : 0;
        if (relevantCount > 0) {
            recallTotal += hits / relevantCount;
            requestsWithPositive += 1;
        }
        candidateCount += request.candidates.length;
        ratedCandidateCount += request.candidates.filter(
            (candidate) => candidate.snapshot.reviewCount > 0,
        ).length;
    }

    return {
        ndcgAt10: requests.length > 0 ? ndcgTotal / requests.length : 0,
        recallAt10:
            requestsWithPositive > 0 ? recallTotal / requestsWithPositive : 0,
        requestCount: requests.length,
        requestsWithPositive,
        requestPositiveCoverage:
            requests.length > 0 ? requestsWithPositive / requests.length : 0,
        ratedCandidateCoverage:
            candidateCount > 0 ? ratedCandidateCount / candidateCount : 0,
    };
}

// Tạo phân phối seed với độ lệch chuẩn mẫu và min/max để thể hiện mức dao động của kết quả synthetic.
function summarize(values: number[]): SeedSummary {
    if (values.length === 0)
        throw new Error('SUMMARY_VALUES_MUST_NOT_BE_EMPTY');
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance =
        values.length > 1
            ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
              (values.length - 1)
            : 0;
    return {
        mean,
        standardDeviation: Math.sqrt(variance),
        minimum: Math.min(...values),
        maximum: Math.max(...values),
    };
}

// Tạo bootstrap index có seed cố định để mọi lần chạy dùng lại cùng paired resamples.
function createBootstrapSamples(sampleCount: number): number[][] {
    const random = createRandomGenerator(BOOTSTRAP_SEED);
    return Array.from({ length: BOOTSTRAP_RESAMPLE_COUNT }, () =>
        Array.from({ length: sampleCount }, () =>
            Math.floor(random() * sampleCount),
        ),
    );
}

// Ước lượng CI percentile của trung bình chênh lệch bằng cách resample các seed theo cặp.
function summarizePairedDelta(
    perSeedDeltas: number[],
    bootstrapSamples: number[][],
): PairedMetricDelta {
    if (perSeedDeltas.length === 0)
        throw new Error('PAIRED_DELTAS_MUST_NOT_BE_EMPTY');

    const bootstrapMeans = bootstrapSamples
        .map((sample) => {
            const sum = sample.reduce(
                (total, index) => total + (perSeedDeltas[index] ?? 0),
                0,
            );
            return sum / sample.length;
        })
        .sort((left, right) => left - right);
    const lowerIndex = Math.floor(bootstrapMeans.length * 0.025);
    const upperIndex = Math.ceil(bootstrapMeans.length * 0.975) - 1;

    return {
        mean:
            perSeedDeltas.reduce((sum, delta) => sum + delta, 0) /
            perSeedDeltas.length,
        confidenceInterval95: {
            lower: bootstrapMeans[lowerIndex] ?? 0,
            upper: bootstrapMeans[upperIndex] ?? 0,
        },
    };
}

// Gộp kết quả từng seed nhưng vẫn giữ từng request macro-average ở bước measureRanking.
function summarizeMethod(perSeed: SeedMethodResult[]): MethodSummary {
    return {
        ndcgAt10: summarize(perSeed.map((result) => result.test.ndcgAt10)),
        recallAt10: summarize(perSeed.map((result) => result.test.recallAt10)),
        requestPositiveCoverage: summarize(
            perSeed.map((result) => result.test.requestPositiveCoverage),
        ),
        ratedCandidateCoverage: summarize(
            perSeed.map((result) => result.test.ratedCandidateCoverage),
        ),
    };
}

// Chạy toàn bộ seed độc lập, chốt μ từ train, tune m trên validation rồi mới đo test một lần.
function runEvaluation(
    features: RankingFeatureService,
): Record<MethodName, MethodResults> {
    const methodNames: MethodName[] = [
        'Project quality',
        'Mean rating',
        'Empirical Bayes',
        'Wilson 95%',
    ];
    const perMethod = new Map<MethodName, SeedMethodResult[]>();
    for (const method of methodNames) perMethod.set(method, []);

    for (let seedOffset = 0; seedOffset < SEED_COUNT; seedOffset += 1) {
        const seed = SEED_START + seedOffset;
        const products = createProducts(seed);
        buildRatingSnapshots(products);
        const requests = createRequests(seed, products, features);
        const trainPriorMean = estimateTrainingPrior(products);
        const validationRequests = requests.filter(
            (request) => request.split === 'validation',
        );
        const testRequests = requests.filter(
            (request) => request.split === 'test',
        );
        const selectedPrior = selectPriorStrength(
            validationRequests,
            trainPriorMean,
        );

        for (const method of methodNames) {
            const priorStrength =
                method === 'Empirical Bayes' ? selectedPrior.strength : 1;
            const validationMetrics =
                method === 'Empirical Bayes'
                    ? selectedPrior.metrics
                    : measureRanking(validationRequests, method, {
                          priorMean: trainPriorMean,
                          priorStrength,
                      });
            const testMetrics = measureRanking(testRequests, method, {
                priorMean: trainPriorMean,
                priorStrength,
            });
            const results = perMethod.get(method);
            if (!results) throw new Error('METHOD_RESULT_BUCKET_MISSING');
            results.push({
                seed,
                validationNdcgAt10: validationMetrics.ndcgAt10,
                test: testMetrics,
                ...(method === 'Empirical Bayes'
                    ? { selectedPriorStrength: selectedPrior.strength }
                    : {}),
            });
        }
    }

    const results = Object.fromEntries(
        methodNames.map((method) => {
            const perSeed = perMethod.get(method);
            if (!perSeed) throw new Error('METHOD_RESULT_BUCKET_MISSING');
            return [method, { summary: summarizeMethod(perSeed), perSeed }];
        }),
    ) as Record<MethodName, MethodResults>;

    const projectResults = results['Project quality'].perSeed;
    const bootstrapSamples = createBootstrapSamples(projectResults.length);
    for (const method of methodNames) {
        if (method === 'Project quality') continue;
        const methodResults = results[method].perSeed;
        const perSeed = methodResults.map((result, index) => {
            const project = projectResults[index];
            if (!project || project.seed !== result.seed)
                throw new Error('PAIRED_SEED_ORDER_MISMATCH');
            return {
                seed: result.seed,
                ndcgAt10: result.test.ndcgAt10 - project.test.ndcgAt10,
                recallAt10: result.test.recallAt10 - project.test.recallAt10,
            };
        });
        results[method].pairedDeltaVsProject = {
            ndcgAt10: summarizePairedDelta(
                perSeed.map((delta) => delta.ndcgAt10),
                bootstrapSamples,
            ),
            recallAt10: summarizePairedDelta(
                perSeed.map((delta) => delta.recallAt10),
                bootstrapSamples,
            ),
            perSeed,
        };
    }

    return results;
}

// In bảng macro-average và JSON máy đọc được để đo lại cùng seed grid khi thay đổi protocol có version.
function printReport(results: Record<MethodName, MethodResults>): void {
    process.stdout.write(
        'Synthetic criterion 7 quality evaluation\n' +
            `Seeds: ${SEED_START}..${SEED_START + SEED_COUNT - 1}; products/seed: ${PRODUCT_COUNT}; requests/seed: ${REQUEST_COUNT}; candidates/request: ${CANDIDATES_PER_REQUEST}; K=${CUTOFF}\n` +
            `Time split: train ${TRAIN_REQUEST_COUNT}, validation ${VALIDATION_END - TRAIN_REQUEST_COUNT}, test ${REQUEST_COUNT - VALIDATION_END}; prior mean from train; empirical-Bayes pseudo-count tuned on validation only.\n` +
            'Labels are Bernoulli clicks from latent product quality using a separate RNG; every method sees the same request candidate set, rating snapshot and outcome.\n' +
            'Test metrics are macro-averages per request; seed spread is sample SD and min-max across seeds.\n\n',
    );
    process.stdout.write(
        'Method           | NDCG@10 mean ± SD [min,max] | Recall@10 mean ± SD [min,max] | Positive request coverage | Rated-candidate coverage\n' +
            '-----------------|-----------------------------|--------------------------------|---------------------------|--------------------------\n',
    );

    for (const [method, result] of Object.entries(results)) {
        const ndcg = result.summary.ndcgAt10;
        const recall = result.summary.recallAt10;
        const positiveCoverage = result.summary.requestPositiveCoverage;
        const ratedCoverage = result.summary.ratedCandidateCoverage;
        process.stdout.write(
            method.padEnd(16) +
                ' | ' +
                `${ndcg.mean.toFixed(4)} ± ${ndcg.standardDeviation.toFixed(4)} [${ndcg.minimum.toFixed(4)},${ndcg.maximum.toFixed(4)}]`.padEnd(
                    27,
                ) +
                ' | ' +
                `${recall.mean.toFixed(4)} ± ${recall.standardDeviation.toFixed(4)} [${recall.minimum.toFixed(4)},${recall.maximum.toFixed(4)}]`.padEnd(
                    30,
                ) +
                ' | ' +
                positiveCoverage.mean.toFixed(4).padEnd(25) +
                ' | ' +
                ratedCoverage.mean.toFixed(4) +
                '\n',
        );
    }

    const empiricalBayes = results['Empirical Bayes'];
    const selectedStrengths = empiricalBayes.perSeed
        .map((result) => result.selectedPriorStrength)
        .filter((value): value is number => value !== undefined);
    process.stdout.write(
        `Validation-selected empirical-Bayes pseudo-counts: ${[...new Set(selectedStrengths)].sort((left, right) => left - right).join(', ')}; mean=${(selectedStrengths.reduce((sum, value) => sum + value, 0) / selectedStrengths.length).toFixed(2)}.\n` +
            '\nPaired deltas versus Project quality (baseline method minus project; 95% percentile bootstrap CI over paired seeds):\n' +
            'Method           | Δ NDCG@10 [95% CI]         | Δ Recall@10 [95% CI]\n' +
            '-----------------|----------------------------|------------------------\n' +
            Object.entries(results)
                .filter(([method]) => method !== 'Project quality')
                .map(([method, result]) => {
                    const paired = result.pairedDeltaVsProject;
                    if (!paired) throw new Error('PAIRED_COMPARISON_MISSING');
                    return (
                        method.padEnd(16) +
                        ' | ' +
                        `${paired.ndcgAt10.mean >= 0 ? '+' : ''}${paired.ndcgAt10.mean.toFixed(5)} [${paired.ndcgAt10.confidenceInterval95.lower.toFixed(5)}, ${paired.ndcgAt10.confidenceInterval95.upper.toFixed(5)}]`.padEnd(
                            32,
                        ) +
                        ' | ' +
                        `${paired.recallAt10.mean >= 0 ? '+' : ''}${paired.recallAt10.mean.toFixed(5)} [${paired.recallAt10.confidenceInterval95.lower.toFixed(5)}, ${paired.recallAt10.confidenceInterval95.upper.toFixed(5)}]`
                    );
                })
                .join('\n') +
            '\nBootstrap: paired seed resampling with replacement, 10,000 replicates, fixed seed 0x7c51a39d; intervals are percentile 2.5th–97.5th.\n' +
            'Synthetic limits: labels follow the declared latent-quality click model, all candidates are treated as equally exposed, ratings are rounded noisy samples, and every candidate is in stock. Results do not establish real-user efficacy or universal optimality.\n' +
            'Per-seed metrics JSON:\n' +
            JSON.stringify(results, null, 2) +
            '\n',
    );
}

// Khởi tạo feature builder trực tiếp với chính sách mặc định; script không mở ứng dụng Nest hay gọi hạ tầng ngoài.
function main(): void {
    const config = {
        get: (_key: string, fallback?: string) => fallback,
    } as ConfigService;
    const featureBuilder = new RankingFeatureService(
        new RecommendationRuleService(config),
    );
    printReport(runEvaluation(featureBuilder));
}

main();
