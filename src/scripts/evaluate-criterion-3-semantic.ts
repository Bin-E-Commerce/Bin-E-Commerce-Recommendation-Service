// Script này so sánh semantic retrieval trên fixture synthetic và gọi trực tiếp hai production transform.
// Nhãn được tạo từ taxonomy ẩn, không đọc score; script không gọi Qdrant thật, không train LambdaRank và không sửa policy.

import { ConfigService } from '@nestjs/config';
import { RecommendationRuleService } from '@/modules/profiles/application/services/rules/recommendation-rule.service';
import { SemanticCandidateService } from '@/modules/recommendation/application/services/candidates/sources/semantic-candidate.service';
import { RankingFeatureService } from '@/modules/recommendation/application/services/ranking/features/ranking-feature.service';
import type { RecommendationCandidate } from '@/modules/recommendation/application/types/ranking/ranking.types';

type SplitName = 'train' | 'validation' | 'test';
type ScenarioName = 'current-item-centric' | 'multi-anchor-intent';
type MethodName =
    | 'production-weighted-centroid'
    | 'validation-tuned-centroid'
    | 'single-anchor-cosine'
    | 'unweighted-centroid-cosine'
    | 'weighted-tfidf-cosine';
type InteractionType =
    'PRODUCT_VIEWED' | 'PRODUCT_CLICKED' | 'PRODUCT_ADDED_TO_CART';
type RandomSource = () => number;

interface SyntheticProduct {
    productId: string;
    topicId: number;
    familyId: number;
    embedding: number[];
    tokens: string[];
    contentHash: string;
    candidate: RecommendationCandidate;
}

interface RecentSignal {
    productId: string;
    weight: number;
    interactionType: InteractionType;
}

interface SyntheticRequest {
    requestId: string;
    requestAt: number;
    split: SplitName;
    targetTopic: number;
    targetFamily: number;
    currentProductId: string;
    recentSignals: RecentSignal[];
    profileProductIds: string[];
    excludedProductIds: string[];
    candidateProductIds: string[];
    relevance: Map<string, number>;
    tieBreakers: Map<string, number>;
}

interface RankingMetrics {
    ndcgAt10: number;
    recallAt10: number;
    requestCount: number;
    positiveRequestCount: number;
}

interface SeedMethodResult {
    seed: number;
    validationNdcgAt10?: number;
    selectedRecentScale?: number;
    test: RankingMetrics;
}

interface Spread {
    mean: number;
    standardDeviation: number;
    minimum: number;
    maximum: number;
}

interface PairedDelta {
    mean: number;
    confidenceInterval95: { lower: number; upper: number };
}

interface MethodResult {
    perSeed: SeedMethodResult[];
    testNdcgAt10: Spread;
    testRecallAt10: Spread;
    deltaNdcgVsProduction: PairedDelta;
    deltaRecallVsProduction: PairedDelta;
}

interface SeedEvaluation {
    seed: number;
    scenario: ScenarioName;
    selectedRecentScale: number;
    validationMetricsByScale: Map<number, RankingMetrics>;
    testMetricsByMethod: Map<MethodName, RankingMetrics>;
}

const TOPIC_COUNT = 12;
const FAMILY_COUNT = 4;
const PRODUCTS_PER_TOPIC = 4;
const PRODUCT_COUNT = TOPIC_COUNT * PRODUCTS_PER_TOPIC;
const REQUEST_COUNT = 500;
const TRAIN_END = Math.floor(REQUEST_COUNT * 0.6);
const VALIDATION_END = Math.floor(REQUEST_COUNT * 0.8);
const SEEDS = Array.from({ length: 20 }, (_, index) => 1_001 + index);
const RECENT_SCALE_GRID = [0.25, 0.5, 1, 2, 4] as const;
const INTERACTION_WEIGHTS: Record<InteractionType, number> = {
    PRODUCT_VIEWED: 1,
    PRODUCT_CLICKED: 2,
    PRODUCT_ADDED_TO_CART: 4,
};
const RECENT_SIGNAL_COUNT = 5;
const PROFILE_PRODUCT_COUNT = 3;
const CUTOFF = 10;
const BOOTSTRAP_SEED = 0x73a512e9;
const BOOTSTRAP_REPLICATES = 4_000;
const REFERENCE_START = Date.parse('2026-01-01T00:00:00.000Z');
const MODEL_VERSION = 'synthetic-text-embedding-v1';
const VECTOR_DIMENSIONS = FAMILY_COUNT + TOPIC_COUNT + 8;
const METHOD_NAMES: MethodName[] = [
    'production-weighted-centroid',
    'validation-tuned-centroid',
    'single-anchor-cosine',
    'unweighted-centroid-cosine',
    'weighted-tfidf-cosine',
];
const SCENARIO_NAMES: ScenarioName[] = [
    'current-item-centric',
    'multi-anchor-intent',
];

// Tạo PRNG có seed cố định để catalog, request, anchor và outcome của mỗi lượt chạy luôn tái tạo được.
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

// Tách seed theo nhãn để sinh nhãn, anchor, nội dung và phá hòa độc lập, không đổi khi thêm baseline.
function deriveSeed(seed: number, label: string): number {
    let hash = (2_166_136_261 ^ seed) >>> 0;
    for (let index = 0; index < label.length; index += 1) {
        hash ^= label.charCodeAt(index);
        hash = Math.imul(hash, 16_777_619) >>> 0;
    }
    return hash;
}

// Sinh nhiễu chuẩn xác định để các sản phẩm cùng chủ đề có vector gần nhau nhưng không đồng nhất.
function normalNoise(random: RandomSource): number {
    const first = Math.max(random(), Number.EPSILON);
    const second = random();
    return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

// Chuẩn hóa vector để evaluator dùng cùng cosine định hướng như collection Qdrant Cosine.
function normalizeVector(vector: number[]): number[] {
    const norm = Math.sqrt(
        vector.reduce((sum, value) => sum + value * value, 0),
    );
    if (norm === 0 || !Number.isFinite(norm)) return vector.map(() => 0);
    return vector.map((value) => value / norm);
}

// Tính cosine theo đúng công thức góc; vector không hợp lệ nhận 0 để metric không phát NaN.
function cosineSimilarity(left: number[], right: number[]): number {
    if (left.length !== right.length || left.length === 0) return 0;
    let dot = 0;
    let leftNormSquared = 0;
    let rightNormSquared = 0;
    for (let index = 0; index < left.length; index += 1) {
        const leftValue = left[index] ?? 0;
        const rightValue = right[index] ?? 0;
        dot += leftValue * rightValue;
        leftNormSquared += leftValue * leftValue;
        rightNormSquared += rightValue * rightValue;
    }
    const denominator = Math.sqrt(leftNormSquared * rightNormSquared);
    return denominator > 0 ? dot / denominator : 0;
}

// Băm request-item ổn định để các phương pháp dùng cùng thứ tự khi semantic feature bị hòa điểm.
function stableTieBreaker(value: string): number {
    let hash = 2_166_136_261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16_777_619) >>> 0;
    }
    return hash / 4_294_967_296;
}

// Sinh vector embedding mô phỏng chủ đề và họ sản phẩm; latent labels bên dưới không đọc vector này.
function createProductEmbedding(
    topicId: number,
    familyId: number,
    random: RandomSource,
): number[] {
    const vector = Array<number>(VECTOR_DIMENSIONS).fill(0);
    vector[familyId] = Math.sqrt(0.16);
    vector[FAMILY_COUNT + topicId] = Math.sqrt(0.76);
    for (
        let index = FAMILY_COUNT + TOPIC_COUNT;
        index < VECTOR_DIMENSIONS;
        index += 1
    ) {
        vector[index] = normalNoise(random) * 0.1;
    }
    return normalizeVector(vector);
}

// Tạo catalog bất biến trước giai đoạn request; mỗi sản phẩm có latent topic, embedding noisy và text synonyms.
function createCatalog(seed: number): SyntheticProduct[] {
    const products: SyntheticProduct[] = [];
    for (let topicId = 0; topicId < TOPIC_COUNT; topicId += 1) {
        const familyId = Math.floor(topicId / (TOPIC_COUNT / FAMILY_COUNT));
        for (let variant = 0; variant < PRODUCTS_PER_TOPIC; variant += 1) {
            const productId = `topic-${topicId}-variant-${variant}`;
            const random = createRandomGenerator(
                deriveSeed(seed, `product:${productId}`),
            );
            products.push({
                productId,
                topicId,
                familyId,
                embedding: createProductEmbedding(topicId, familyId, random),
                // Mỗi biến thể dùng alias từ vựng khác nhau; family token còn lại làm lexical retrieval có tín hiệu yếu.
                tokens: [
                    'family-' + familyId,
                    'synonym-' + topicId + '-' + variant,
                    'brand-' + (variant % 3),
                    'attribute-' + ((topicId + variant) % 5),
                    'product',
                ],
                contentHash: `hash-${productId}`,
                candidate: createCandidateFixture(productId, familyId),
            });
        }
    }
    return products;
}

// Tạo contract tối thiểu cho production feature builder; các feature ngoài semantic được giữ bằng nhau để không ảnh hưởng phép đo.
function createCandidateFixture(
    productId: string,
    familyId: number,
): RecommendationCandidate {
    const product = {
        productId,
        name: productId,
        slug: productId,
        imageUrl: null,
        categoryId: `family-${familyId}`,
        brandId: 'synthetic-brand',
        sellerShopId: 'synthetic-shop',
        minPrice: '1',
        maxPrice: '1',
        ratingAvg: '4',
        reviewCount: 10,
        totalSold: 0,
        status: 'ACTIVE',
        isInStock: true,
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
        updatedAt: new Date('2025-01-01T00:00:00.000Z'),
        catalogVersion: 'synthetic-v1',
        shortDescription: null,
        description: null,
        brandName: null,
        categoryPath: null,
        semanticAttributes: [],
        contentHash: null,
        embeddingStatus: 'READY',
        embeddingModelVersion: MODEL_VERSION,
        embeddingDimensions: VECTOR_DIMENSIONS,
    } as RecommendationCandidate['product'];
    return {
        product,
        sources: new Set(['SEMANTIC_SIMILARITY']),
        contributions: [],
    };
}

// Tạo TF-IDF L2 vectors trên catalog text đã có trước mọi request; không dùng label hay outcome để fit IDF.
function createTfidfVectors(
    products: SyntheticProduct[],
): Map<string, number[]> {
    const documentFrequency = new Map<string, number>();
    for (const product of products) {
        for (const token of new Set(product.tokens)) {
            documentFrequency.set(
                token,
                (documentFrequency.get(token) ?? 0) + 1,
            );
        }
    }
    const vocabulary = [...documentFrequency.keys()].sort();
    const indexByToken = new Map(
        vocabulary.map((token, index) => [token, index]),
    );
    const idf = vocabulary.map(
        (token) =>
            Math.log(
                (products.length + 1) /
                    ((documentFrequency.get(token) ?? 0) + 1),
            ) + 1,
    );
    const result = new Map<string, number[]>();
    for (const product of products) {
        const termFrequency = new Map<string, number>();
        for (const token of product.tokens) {
            termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
        }
        const vector = Array<number>(vocabulary.length).fill(0);
        for (const [token, count] of termFrequency) {
            const index = indexByToken.get(token);
            if (index !== undefined) vector[index] = count * (idf[index] ?? 0);
        }
        result.set(product.productId, normalizeVector(vector));
    }
    return result;
}

// Chọn một biến thể chưa dùng trong topic yêu cầu; fallback có thứ tự ổn định nếu nhóm đã hết item.
function chooseProduct(
    topicId: number,
    productsByTopic: Map<number, SyntheticProduct[]>,
    usedProductIds: Set<string>,
    random: RandomSource,
): SyntheticProduct {
    const available = (productsByTopic.get(topicId) ?? []).filter(
        (product) => !usedProductIds.has(product.productId),
    );
    if (available.length === 0) {
        const fallback = [...productsByTopic.values()]
            .flat()
            .find((product) => !usedProductIds.has(product.productId));
        if (!fallback) throw new Error('SYNTHETIC_ANCHORS_EXHAUSTED_CATALOG');
        usedProductIds.add(fallback.productId);
        return fallback;
    }
    const selected = available[Math.floor(random() * available.length)];
    if (!selected) throw new Error('SYNTHETIC_PRODUCT_SELECTION_FAILED');
    usedProductIds.add(selected.productId);
    return selected;
}

// Chọn topic nhiễu khác topic đích để lịch sử không phải lúc nào cũng hoàn toàn trùng ngữ cảnh hiện tại.
function chooseDistractorTopic(
    targetTopic: number,
    random: RandomSource,
): number {
    const offset = 1 + Math.floor(random() * (TOPIC_COUNT - 1));
    return (targetTopic + offset) % TOPIC_COUNT;
}

// Tạo request theo thời gian; grade chỉ phụ thuộc intent topic ẩn và taxonomy sản phẩm, không phụ thuộc scorer nào.
function createRequests(
    seed: number,
    products: SyntheticProduct[],
    scenario: ScenarioName,
): SyntheticRequest[] {
    const productsByTopic = new Map<number, SyntheticProduct[]>();
    const productById = new Map(
        products.map((product) => [product.productId, product]),
    );
    for (const product of products) {
        const topicProducts = productsByTopic.get(product.topicId) ?? [];
        topicProducts.push(product);
        productsByTopic.set(product.topicId, topicProducts);
    }

    return Array.from({ length: REQUEST_COUNT }, (_, requestIndex) => {
        const requestId = `semantic-request-${String(requestIndex + 1).padStart(4, '0')}`;
        const random = createRandomGenerator(
            deriveSeed(seed, `request:${requestIndex}`),
        );
        const targetTopic = Math.floor(random() * TOPIC_COUNT);
        const targetFamily = Math.floor(
            targetTopic / (TOPIC_COUNT / FAMILY_COUNT),
        );
        const usedProductIds = new Set<string>();
        // Current-item-centric giả định sản phẩm đang xem đã thể hiện intent; multi-anchor cho phép item đó cũ/lệch.
        const currentTopic =
            scenario === 'current-item-centric' || random() < 0.45
                ? targetTopic
                : chooseDistractorTopic(targetTopic, random);
        const currentProduct = chooseProduct(
            currentTopic,
            productsByTopic,
            usedProductIds,
            random,
        );

        const recentSignals: RecentSignal[] = [];
        for (let position = 0; position < RECENT_SIGNAL_COUNT; position += 1) {
            // Tín hiệu mới có xác suất cao hơn thuộc intent hiện tại; trọng số event là input, không sinh outcome.
            const targetProbability =
                scenario === 'current-item-centric'
                    ? 0.78 - position * 0.1
                    : 0.88 - position * 0.055;
            const topicId =
                random() < targetProbability
                    ? targetTopic
                    : chooseDistractorTopic(targetTopic, random);
            const product = chooseProduct(
                topicId,
                productsByTopic,
                usedProductIds,
                random,
            );
            const interactionDraw = random();
            const interactionType: InteractionType =
                interactionDraw < 0.5
                    ? 'PRODUCT_VIEWED'
                    : interactionDraw < 0.82
                      ? 'PRODUCT_CLICKED'
                      : 'PRODUCT_ADDED_TO_CART';
            recentSignals.push({
                productId: product.productId,
                weight: INTERACTION_WEIGHTS[interactionType],
                interactionType,
            });
        }

        const profileProductIds: string[] = [];
        for (let index = 0; index < PROFILE_PRODUCT_COUNT; index += 1) {
            // Hồ sơ dài hạn thường ở cùng family nhưng có thể lệch khỏi topic anchor hiện tại.
            const sameFamily = random() < 0.55;
            const topicId =
                scenario === 'multi-anchor-intent' && random() < 0.75
                    ? targetTopic
                    : sameFamily
                      ? targetFamily * (TOPIC_COUNT / FAMILY_COUNT) +
                        Math.floor(random() * (TOPIC_COUNT / FAMILY_COUNT))
                      : chooseDistractorTopic(targetTopic, random);
            const product = chooseProduct(
                topicId,
                productsByTopic,
                usedProductIds,
                random,
            );
            profileProductIds.push(product.productId);
        }

        const excludedProductIds = [...usedProductIds];
        const candidateProductIds = products
            .filter((product) => !usedProductIds.has(product.productId))
            .map((product) => product.productId);
        const relevance = new Map<string, number>();
        const tieBreakers = new Map<string, number>();
        for (const productId of candidateProductIds) {
            const product = productById.get(productId);
            if (!product) throw new Error('SYNTHETIC_CANDIDATE_MISSING');
            // Rubric 2=same topic, 1=same product family, 0=other family; no score or vector is consulted.
            relevance.set(
                productId,
                product.topicId === targetTopic
                    ? 2
                    : product.familyId === targetFamily
                      ? 1
                      : 0,
            );
            tieBreakers.set(
                productId,
                stableTieBreaker(requestId + ':' + productId),
            );
        }

        return {
            requestId,
            requestAt: REFERENCE_START + requestIndex * 60_000,
            split:
                requestIndex < TRAIN_END
                    ? 'train'
                    : requestIndex < VALIDATION_END
                      ? 'validation'
                      : 'test',
            targetTopic,
            targetFamily,
            currentProductId: currentProduct.productId,
            recentSignals,
            profileProductIds,
            excludedProductIds,
            candidateProductIds,
            relevance,
            tieBreakers,
        };
    });
}

// Tạo các weight thật của SemanticCandidateService; multiplier chỉ thay recent signals trong thí nghiệm validation.
function productionAnchorWeights(
    request: SyntheticRequest,
    recentScale: number,
): Map<string, number> {
    const weights = new Map<string, number>();
    weights.set(request.currentProductId, 1);
    for (const signal of request.recentSignals) {
        weights.set(
            signal.productId,
            (weights.get(signal.productId) ?? 0) + signal.weight * recentScale,
        );
    }
    for (const productId of request.profileProductIds) {
        weights.set(productId, (weights.get(productId) ?? 0) + 0.5);
    }
    return weights;
}

// Tạo fake catalog/vector port cho SemanticCandidateService; vector search dùng exact cosine và trả cùng candidate pool.
function createSemanticCandidateService(
    products: SyntheticProduct[],
    rules: RecommendationRuleService,
): SemanticCandidateService {
    const productById = new Map(
        products.map((product) => [product.productId, product]),
    );
    const vectorPort = {
        getProductVector: async (
            productId: string,
            expectedContentHash?: string,
        ) => {
            const product = productById.get(productId);
            if (!product || product.contentHash !== expectedContentHash)
                return null;
            return {
                vector: product.embedding,
                contentHash: product.contentHash,
                modelVersion: MODEL_VERSION,
            };
        },
        searchSimilarProducts: async (
            query: number[],
            limit: number,
            excludeProductIds: string[] = [],
        ) => {
            const excluded = new Set(excludeProductIds);
            return products
                .filter((product) => !excluded.has(product.productId))
                .map((product) => ({
                    productId: product.productId,
                    similarityScore: cosineSimilarity(query, product.embedding),
                    modelVersion: MODEL_VERSION,
                    contentHash: product.contentHash,
                }))
                .sort(
                    (left, right) =>
                        right.similarityScore - left.similarityScore ||
                        left.productId.localeCompare(right.productId),
                )
                .slice(0, Math.min(Math.max(limit, 1), 60));
        },
    };
    const catalogPort = {
        findSnapshots: async (productIds: string[]) =>
            productIds.flatMap((productId) => {
                const product = productById.get(productId);
                return product
                    ? [{ productId, contentHash: product.contentHash }]
                    : [];
            }),
    };
    return new SemanticCandidateService(
        vectorPort as never,
        catalogPort as never,
        rules,
    );
}

// Chạy raw score qua RankingFeatureService.build để mọi baseline dùng đúng clamp/source transform của production.
function toProductionFeatureScore(
    product: SyntheticProduct,
    rawScore: number,
    requestAt: number,
    featureBuilder: RankingFeatureService,
): number {
    const candidate: RecommendationCandidate = {
        ...product.candidate,
        contributions: [
            {
                source: 'SEMANTIC_SIMILARITY',
                rawScore,
                reasonCode: 'SYNTHETIC_SEMANTIC_MATCH',
            },
        ],
    };
    return featureBuilder.build(
        candidate,
        [],
        [],
        [],
        null,
        undefined,
        new Date(requestAt),
    ).semanticSimilarity;
}

// Chấm một query vector trên candidate pool cố định, rồi áp đúng production feature transform cho từng score.
function scoreQueryVector(
    request: SyntheticRequest,
    productsById: Map<string, SyntheticProduct>,
    queryVector: number[],
    candidateVectors: Map<string, number[]>,
    featureBuilder: RankingFeatureService,
): Map<string, number> {
    const scores = new Map<string, number>();
    for (const productId of request.candidateProductIds) {
        const product = productsById.get(productId);
        const candidateVector = candidateVectors.get(productId);
        if (!product || !candidateVector)
            throw new Error('SYNTHETIC_SCORE_INPUT_MISSING');
        scores.set(
            productId,
            toProductionFeatureScore(
                product,
                cosineSimilarity(queryVector, candidateVector),
                request.requestAt,
                featureBuilder,
            ),
        );
    }
    return scores;
}

// Lấy query centroid từ map vector/weight; normalize tùy chọn chỉ đổi độ dài, không đổi cosine ranking.
function buildCentroid(
    weights: Map<string, number>,
    vectors: Map<string, number[]>,
): number[] {
    let totalWeight = 0;
    let dimensionCount = 0;
    for (const [productId, weight] of weights) {
        const vector = vectors.get(productId);
        if (!vector || !Number.isFinite(weight) || weight <= 0) continue;
        totalWeight += weight;
        dimensionCount = vector.length;
    }
    if (totalWeight <= 0 || dimensionCount === 0) return [];

    const query = Array<number>(dimensionCount).fill(0);
    for (const [productId, weight] of weights) {
        const vector = vectors.get(productId);
        if (!vector || !Number.isFinite(weight) || weight <= 0) continue;
        for (let index = 0; index < dimensionCount; index += 1) {
            query[index] = (query[index] ?? 0) + (vector[index] ?? 0) * weight;
        }
    }
    return query.map((value) => value / totalWeight);
}

// Đánh giá weighted centroid production qua SemanticCandidateService và giữ đúng candidate pool/labels của request.
async function scoreProductionCentroid(
    request: SyntheticRequest,
    productsById: Map<string, SyntheticProduct>,
    semanticService: SemanticCandidateService,
    featureBuilder: RankingFeatureService,
    recentScale: number,
): Promise<Map<string, number>> {
    const candidates = await semanticService.findCandidates({
        productId: request.currentProductId,
        recentProductIds: request.recentSignals.map(
            (signal) => signal.productId,
        ),
        recentProductSignals: request.recentSignals.map((signal) => ({
            ...signal,
            weight: signal.weight * recentScale,
        })),
        profileProductIds: request.profileProductIds,
        excludeProductIds: request.excludedProductIds,
        limit: 60,
    });
    if (candidates.length !== request.candidateProductIds.length) {
        throw new Error(
            'PRODUCTION_SOURCE_DID_NOT_RETURN_FIXED_CANDIDATE_POOL',
        );
    }

    const scores = new Map<string, number>();
    for (const candidate of candidates) {
        const product = productsById.get(candidate.productId);
        if (!product) throw new Error('PRODUCTION_CANDIDATE_NOT_IN_CATALOG');
        scores.set(
            candidate.productId,
            toProductionFeatureScore(
                product,
                candidate.rawScore,
                request.requestAt,
                featureBuilder,
            ),
        );
    }
    return scores;
}

// Tạo graded relevance metrics theo request; DCG dùng gain 2^grade−1, Recall tính item có grade lớn hơn 0.
function measureRanking(
    requests: SyntheticRequest[],
    scoreByRequest: Map<string, Map<string, number>>,
): RankingMetrics {
    let ndcgSum = 0;
    let recallSum = 0;
    let positiveRequestCount = 0;
    for (const request of requests) {
        const scores = scoreByRequest.get(request.requestId);
        if (!scores) throw new Error('RANKING_SCORES_MISSING_FOR_REQUEST');
        const orderedIds = [...request.candidateProductIds].sort(
            (left, right) =>
                (scores.get(right) ?? 0) - (scores.get(left) ?? 0) ||
                (request.tieBreakers.get(left) ?? 0) -
                    (request.tieBreakers.get(right) ?? 0),
        );
        const idealGrades = request.candidateProductIds
            .map((productId) => request.relevance.get(productId) ?? 0)
            .sort((left, right) => right - left);
        const actualDcg = calculateDcg(orderedIds, request.relevance);
        const idealDcg = calculateDcg(idealGrades, true);
        ndcgSum += idealDcg > 0 ? actualDcg / idealDcg : 0;

        const relevantCount = request.candidateProductIds.reduce(
            (count, productId) =>
                count + Number((request.relevance.get(productId) ?? 0) > 0),
            0,
        );
        if (relevantCount > 0) {
            positiveRequestCount += 1;
            const hits = orderedIds
                .slice(0, CUTOFF)
                .reduce(
                    (count, productId) =>
                        count +
                        Number((request.relevance.get(productId) ?? 0) > 0),
                    0,
                );
            recallSum += hits / relevantCount;
        }
    }
    return {
        ndcgAt10: requests.length ? ndcgSum / requests.length : 0,
        recallAt10: positiveRequestCount ? recallSum / positiveRequestCount : 0,
        requestCount: requests.length,
        positiveRequestCount,
    };
}

// Tính DCG tại cutoff 10 cho danh sách ID hoặc danh sách relevance đã sắp theo mức giảm dần.
function calculateDcg(
    ranked: string[] | number[],
    relevance: Map<string, number> | true,
): number {
    let dcg = 0;
    for (let index = 0; index < Math.min(CUTOFF, ranked.length); index += 1) {
        const item = ranked[index];
        const grade =
            typeof item === 'number'
                ? item
                : typeof item === 'string' && relevance !== true
                  ? (relevance.get(item) ?? 0)
                  : 0;
        dcg += (2 ** grade - 1) / Math.log2(index + 2);
    }
    return dcg;
}

// Tạo bootstrap index cố định để mọi phương pháp dùng cùng các lần resample seed khi so paired delta.
function createBootstrapSamples(seedCount: number): number[][] {
    const random = createRandomGenerator(BOOTSTRAP_SEED);
    return Array.from({ length: BOOTSTRAP_REPLICATES }, () =>
        Array.from({ length: seedCount }, () =>
            Math.floor(random() * seedCount),
        ),
    );
}

// Tóm tắt metric qua seed và trả biến thiên sample SD để synthetic result không phụ thuộc một seed đơn lẻ.
function summarizeSpread(values: number[]): Spread {
    if (values.length === 0) throw new Error('METRIC_VALUES_MUST_NOT_BE_EMPTY');
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

// Resample paired seed-level deltas; each seed contains the same synthetic requests for both methods.
function summarizePairedDelta(
    deltas: number[],
    bootstrapSamples: number[][],
): PairedDelta {
    const bootstrapMeans = bootstrapSamples
        .map(
            (sample) =>
                sample.reduce((sum, index) => sum + (deltas[index] ?? 0), 0) /
                Math.max(sample.length, 1),
        )
        .sort((left, right) => left - right);
    const lowerIndex = Math.floor(bootstrapMeans.length * 0.025);
    const upperIndex = Math.ceil(bootstrapMeans.length * 0.975) - 1;
    return {
        mean: deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length,
        confidenceInterval95: {
            lower: bootstrapMeans[lowerIndex] ?? 0,
            upper: bootstrapMeans[upperIndex] ?? 0,
        },
    };
}

// Chạy một seed: chọn recentScale chỉ theo validation, rồi mở test để chấm đúng một lần.
async function evaluateSeed(
    seed: number,
    scenario: ScenarioName,
    rules: RecommendationRuleService,
    featureBuilder: RankingFeatureService,
): Promise<SeedEvaluation> {
    const products = createCatalog(seed);
    const productsById = new Map(
        products.map((product) => [product.productId, product]),
    );
    const embeddingVectors = new Map(
        products.map((product) => [product.productId, product.embedding]),
    );
    const tfidfVectors = createTfidfVectors(products);
    const requests = createRequests(seed, products, scenario);
    const validationRequests = requests.filter(
        (request) => request.split === 'validation',
    );
    const testRequests = requests.filter((request) => request.split === 'test');
    const semanticService = createSemanticCandidateService(products, rules);

    const validationMetricsByScale = new Map<number, RankingMetrics>();
    for (const recentScale of RECENT_SCALE_GRID) {
        const scores = new Map<string, Map<string, number>>();
        for (const request of validationRequests) {
            scores.set(
                request.requestId,
                await scoreProductionCentroid(
                    request,
                    productsById,
                    semanticService,
                    featureBuilder,
                    recentScale,
                ),
            );
        }
        validationMetricsByScale.set(
            recentScale,
            measureRanking(validationRequests, scores),
        );
    }

    // Chỉ validation được phép chọn recentScale; nếu NDCG bằng nhau thì ưu tiên scale production 1.
    const selectedRecentScale = [...validationMetricsByScale.entries()].sort(
        (left, right) =>
            right[1].ndcgAt10 - left[1].ndcgAt10 ||
            Math.abs(left[0] - 1) - Math.abs(right[0] - 1) ||
            left[0] - right[0],
    )[0]?.[0];
    if (selectedRecentScale === undefined)
        throw new Error('RECENT_SCALE_GRID_MUST_NOT_BE_EMPTY');

    const testScoresByMethod = new Map<
        MethodName,
        Map<string, Map<string, number>>
    >();
    for (const method of METHOD_NAMES)
        testScoresByMethod.set(method, new Map());
    for (const request of testRequests) {
        const productionScores = await scoreProductionCentroid(
            request,
            productsById,
            semanticService,
            featureBuilder,
            1,
        );
        const tunedScores =
            selectedRecentScale === 1
                ? productionScores
                : await scoreProductionCentroid(
                      request,
                      productsById,
                      semanticService,
                      featureBuilder,
                      selectedRecentScale,
                  );
        testScoresByMethod
            .get('production-weighted-centroid')
            ?.set(request.requestId, productionScores);
        testScoresByMethod
            .get('validation-tuned-centroid')
            ?.set(request.requestId, tunedScores);

        const singleAnchor = embeddingVectors.get(request.currentProductId);
        if (!singleAnchor) throw new Error('CURRENT_ANCHOR_VECTOR_MISSING');
        testScoresByMethod
            .get('single-anchor-cosine')
            ?.set(
                request.requestId,
                scoreQueryVector(
                    request,
                    productsById,
                    singleAnchor,
                    embeddingVectors,
                    featureBuilder,
                ),
            );

        const unweightedWeights = new Map(
            request.excludedProductIds.map((productId) => [productId, 1]),
        );
        const unweightedQuery = buildCentroid(
            unweightedWeights,
            embeddingVectors,
        );
        testScoresByMethod
            .get('unweighted-centroid-cosine')
            ?.set(
                request.requestId,
                scoreQueryVector(
                    request,
                    productsById,
                    unweightedQuery,
                    embeddingVectors,
                    featureBuilder,
                ),
            );

        const tfidfWeights = productionAnchorWeights(request, 1);
        const tfidfQuery = buildCentroid(tfidfWeights, tfidfVectors);
        testScoresByMethod
            .get('weighted-tfidf-cosine')
            ?.set(
                request.requestId,
                scoreQueryVector(
                    request,
                    productsById,
                    tfidfQuery,
                    tfidfVectors,
                    featureBuilder,
                ),
            );
    }

    const testMetricsByMethod = new Map<MethodName, RankingMetrics>();
    for (const method of METHOD_NAMES) {
        const methodScores = testScoresByMethod.get(method);
        if (!methodScores) throw new Error('METHOD_SCORE_MAP_MISSING');
        testMetricsByMethod.set(
            method,
            measureRanking(testRequests, methodScores),
        );
    }
    return {
        seed,
        scenario,
        selectedRecentScale,
        validationMetricsByScale,
        testMetricsByMethod,
    };
}

// Chạy các seed độc lập rồi tổng hợp seed spread và paired bootstrap CI so với đúng công thức production.
async function runEvaluation(
    rules: RecommendationRuleService,
    featureBuilder: RankingFeatureService,
): Promise<Record<ScenarioName, Record<MethodName, MethodResult>>> {
    const bootstrapSamples = createBootstrapSamples(SEEDS.length);
    const byScenario = {} as Record<
        ScenarioName,
        Record<MethodName, MethodResult>
    >;
    for (const scenario of SCENARIO_NAMES) {
        const seedEvaluations: SeedEvaluation[] = [];
        for (const seed of SEEDS) {
            seedEvaluations.push(
                await evaluateSeed(seed, scenario, rules, featureBuilder),
            );
        }
        const productionResults = seedEvaluations.map((seed) => {
            const metrics = seed.testMetricsByMethod.get(
                'production-weighted-centroid',
            );
            if (!metrics) throw new Error('PRODUCTION_TEST_METRICS_MISSING');
            return metrics;
        });

        byScenario[scenario] = Object.fromEntries(
            METHOD_NAMES.map((method) => {
                const testMetrics = seedEvaluations.map((seed) => {
                    const metrics = seed.testMetricsByMethod.get(method);
                    if (!metrics) throw new Error('TEST_METRICS_MISSING');
                    return metrics;
                });
                const ndcgDeltas = testMetrics.map(
                    (metrics, index) =>
                        metrics.ndcgAt10 -
                        (productionResults[index]?.ndcgAt10 ?? 0),
                );
                const recallDeltas = testMetrics.map(
                    (metrics, index) =>
                        metrics.recallAt10 -
                        (productionResults[index]?.recallAt10 ?? 0),
                );
                const perSeed = seedEvaluations.map((seed, index) => ({
                    seed: seed.seed,
                    ...(method === 'validation-tuned-centroid'
                        ? {
                              selectedRecentScale: seed.selectedRecentScale,
                              validationNdcgAt10:
                                  seed.validationMetricsByScale.get(
                                      seed.selectedRecentScale,
                                  )?.ndcgAt10 ?? 0,
                          }
                        : {}),
                    test: testMetrics[index]!,
                }));
                const result: MethodResult = {
                    perSeed,
                    testNdcgAt10: summarizeSpread(
                        testMetrics.map((metrics) => metrics.ndcgAt10),
                    ),
                    testRecallAt10: summarizeSpread(
                        testMetrics.map((metrics) => metrics.recallAt10),
                    ),
                    deltaNdcgVsProduction: summarizePairedDelta(
                        ndcgDeltas,
                        bootstrapSamples,
                    ),
                    deltaRecallVsProduction: summarizePairedDelta(
                        recallDeltas,
                        bootstrapSamples,
                    ),
                };
                return [method, result];
            }),
        ) as Record<MethodName, MethodResult>;
    }
    return byScenario;
}

// In thành bảng tổng hợp và lưu per-seed số liệu để báo cáo có thể được kiểm tra/lặp lại.
function printScenarioReport(
    scenario: ScenarioName,
    results: Record<MethodName, MethodResult>,
): string[] {
    const lines = [
        `### Scenario: ${scenario}`,
        scenario === 'current-item-centric'
            ? 'The target topic equals the current product topic by construction; this intentionally tests item-to-item retrieval and makes single-anchor cosine a strong/near-oracle baseline for this scenario.'
            : 'The target topic is generated independently; the current product matches it in 45% of requests and is stale/noisy otherwise, while recent/profile anchors carry the intended topic signal.',
        '',
        '| Method | Test NDCG@10 mean ± SD [min,max] | Test Recall@10 mean ± SD [min,max] | ΔNDCG vs production (paired 95% CI) | ΔRecall vs production (paired 95% CI) |',
        '| --- | ---: | ---: | ---: | ---: |',
    ];
    for (const method of METHOD_NAMES) {
        const result = results[method];
        const ndcg = result.testNdcgAt10;
        const recall = result.testRecallAt10;
        lines.push(
            `| ${method} | ${ndcg.mean.toFixed(4)} ± ${ndcg.standardDeviation.toFixed(4)} [${ndcg.minimum.toFixed(4)}, ${ndcg.maximum.toFixed(4)}] | ${recall.mean.toFixed(4)} ± ${recall.standardDeviation.toFixed(4)} [${recall.minimum.toFixed(4)}, ${recall.maximum.toFixed(4)}] | ${result.deltaNdcgVsProduction.mean.toFixed(4)} [${result.deltaNdcgVsProduction.confidenceInterval95.lower.toFixed(4)}, ${result.deltaNdcgVsProduction.confidenceInterval95.upper.toFixed(4)}] | ${result.deltaRecallVsProduction.mean.toFixed(4)} [${result.deltaRecallVsProduction.confidenceInterval95.lower.toFixed(4)}, ${result.deltaRecallVsProduction.confidenceInterval95.upper.toFixed(4)}] |`,
        );
    }
    const tunedScales = results['validation-tuned-centroid'].perSeed
        .map((result) => result.selectedRecentScale)
        .filter((value): value is number => value !== undefined);
    lines.push(
        '',
        `Validation-selected recent weight multipliers by seed: ${tunedScales.join(', ')}`,
        'Paired 95% CI resamples seed-level test deltas with a fixed bootstrap seed; methods share each seed, request set, candidate pool, label and tie-break.',
    );
    return lines;
}

// In các scenario riêng; không gộp bảng vì nhãn multi-anchor và nhãn current-item trả lời hai câu hỏi khác nhau.
function printReport(
    results: Record<ScenarioName, Record<MethodName, MethodResult>>,
): void {
    const lines = [
        'Criterion 3 semantic/content similarity — synthetic evaluation only',
        `Seeds: ${SEEDS.join(', ')}`,
        `Requests per seed per scenario: ${REQUEST_COUNT} (train ${TRAIN_END}, validation ${VALIDATION_END - TRAIN_END}, test ${REQUEST_COUNT - VALIDATION_END})`,
        `Catalog: ${PRODUCT_COUNT} fixed items; anchor exclusions are shared by every method; cutoff: ${CUTOFF}`,
        'Production path: SemanticCandidateService weighted centroid + mocked exact-cosine Qdrant port + RankingFeatureService semantic clamp.',
        'Labels: grade 2=same latent topic, 1=same product family, 0=other family; labels are generated before scoring and do not read embeddings or formula scores.',
        'TF-IDF uses catalog-only smoothed IDF: tf × (log((N+1)/(df+1))+1), L2-normalized; content snapshot is fixed before request time.',
        'The chronological train split is intentionally unused: no model is fitted in this feature-only benchmark. Validation selects recentScale; test is untouched.',
        'NDCG@10 and Recall@10 rank this semantic feature alone; LambdaRank is not trained or evaluated.',
        '',
    ];
    for (const scenario of SCENARIO_NAMES) {
        const scenarioResults = results[scenario];
        lines.push(
            ...printScenarioReport(scenario, scenarioResults),
            '',
            'Per-seed metrics JSON:',
            JSON.stringify(scenarioResults, null, 2),
            '',
        );
    }
    lines.push(
        'Synthetic limits: topic/family rubric is a designed proxy, the embedding space is generated from that taxonomy, every item is eligible, and all candidates are treated as equally exposed. This evaluator checks deterministic behavior and split/tuning discipline; it is not evidence of real-user semantic quality or LambdaRank lift.',
    );
    process.stdout.write(lines.join('\n') + '\n');
}

// Khởi tạo rule/feature production trực tiếp với default config; không mở Nest application hay dùng hạ tầng ngoài.
async function main(): Promise<void> {
    const config = {
        get: (_key: string, fallback?: string) => fallback,
    } as ConfigService;
    const rules = new RecommendationRuleService(config);
    const featureBuilder = new RankingFeatureService(rules);
    printReport(await runEvaluation(rules, featureBuilder));
}

void main().catch((error: unknown) => {
    const message =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(message + '\n');
    process.exitCode = 1;
});
