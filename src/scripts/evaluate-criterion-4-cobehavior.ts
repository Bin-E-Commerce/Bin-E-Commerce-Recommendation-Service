// File này so sánh feature coBehavior production với các baseline item-item trên dữ liệu synthetic có seed cố định.
// Script chỉ sở hữu evaluator ngoại tuyến; không ghi dữ liệu nghiệp vụ, không huấn luyện model và không sửa policy production.

import { ConfigService } from '@nestjs/config';
import { RecommendationRuleService } from '@/modules/profiles/application/services/rules/recommendation-rule.service';
import { RankingFeatureService } from '@/modules/recommendation/application/services/ranking/features/ranking-feature.service';
import type { RecommendationCandidate } from '@/modules/recommendation/application/types/ranking/ranking.types';

type RelationType = 'CO_VIEW' | 'CO_CART' | 'CO_PURCHASE';
type SplitName = 'validation' | 'test';
type MethodName =
    | 'production-default'
    | 'production-tuned-scale'
    | 'raw-co-occurrence'
    | 'item-item-cosine'
    | 'purchase-confidence'
    | 'purchase-lift';

interface RandomState {
    value: number;
}

interface SyntheticProduct {
    productId: string;
    bundleId: number | null;
    isHub: boolean;
    categoryId: string;
    brandId: string;
    candidate: RecommendationCandidate;
}

interface SyntheticBasket {
    basketId: string;
    day: number;
    relationType: RelationType;
    productIds: string[];
    scoreDelta: number;
    returned: boolean;
}

interface PairAggregate {
    score: number;
    lastSignalDay: number;
}

interface SyntheticRequest {
    requestId: string;
    day: number;
    split: SplitName;
    intentBundleId: number;
    anchorProductIds: string[];
    candidateProductIds: string[];
    labels: Map<string, number>;
    tieBreakers: Map<string, number>;
}

interface SeedDataset {
    seed: number;
    products: SyntheticProduct[];
    productById: Map<string, SyntheticProduct>;
    trainBaskets: SyntheticBasket[];
    validationRequests: SyntheticRequest[];
    testRequests: SyntheticRequest[];
    relationAggregates: Map<string, PairAggregate>;
    cosineMatrix: Float64Array;
    orderCount: number;
    orderItemCounts: Uint32Array;
    orderPairCounts: Uint32Array;
}

interface RankingMetrics {
    ndcgAt10: number;
    recallAt10: number;
    candidateScoreCoverage: number;
    requestScoreCoverage: number;
    requestCount: number;
    positiveRequestCount: number;
}

interface SeedMethodResult {
    validation: RankingMetrics;
    test: RankingMetrics;
}

interface MetricSpread {
    mean: number;
    standardDeviation: number;
    minimum: number;
    maximum: number;
}

interface MethodSummary {
    validationNdcg: MetricSpread;
    testNdcg: MetricSpread;
    testRecall: MetricSpread;
    testCandidateCoverage: MetricSpread;
    testRequestCoverage: MetricSpread;
}

const SEEDS = [17, 29, 41, 53, 67, 79, 97, 101] as const;
const BUNDLE_COUNT = 18;
const PRODUCTS_PER_BUNDLE = 8;
const POPULAR_HUB_COUNT = 8;
const TRAIN_BASKET_COUNT = 600;
const VALIDATION_REQUEST_COUNT = 80;
const TEST_REQUEST_COUNT = 100;
const VALIDATION_START_DAY = 61;
const TEST_START_DAY = 81;
const SPLIT_DURATION_DAYS = 20;
const RELATION_HALF_LIFE_DAYS = 30;
const CUTOFF = 10;
const SCALE_MULTIPLIERS = [0.5, 0.75, 1, 1.5, 2] as const;
const RELATION_TYPES: RelationType[] = ['CO_PURCHASE', 'CO_CART', 'CO_VIEW'];

// Cập nhật bộ sinh số tuyến tính đồng thời trả về giá trị trong [0, 1), để mọi lần chạy tái tạo cùng basket và nhãn.
function nextRandom(state: RandomState): number {
    state.value = (Math.imul(state.value, 1_664_525) + 1_013_904_223) >>> 0;
    return state.value / 4_294_967_296;
}

// Tạo trạng thái ngẫu nhiên riêng theo seed để thêm một split hoặc metric không làm đổi dữ liệu đã sinh.
function createRandomState(seed: number): RandomState {
    return { value: seed >>> 0 };
}

// Băm nhãn thành seed 32-bit ổn định để luồng query, outcome và tie-break không dùng chung trạng thái.
function deriveSeed(seed: number, label: string): number {
    let hash = (2_166_136_261 ^ seed) >>> 0;
    for (let index = 0; index < label.length; index += 1) {
        hash ^= label.charCodeAt(index);
        hash = Math.imul(hash, 16_777_619) >>> 0;
    }
    return hash;
}

// Tạo khóa phá hòa theo request-item để thứ tự đầu vào catalog không thiên vị một ranker.
function stableTieBreaker(value: string): number {
    let hash = 2_166_136_261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16_777_619) >>> 0;
    }
    return hash / 4_294_967_296;
}

// Tạo catalog gồm mặt hàng thuộc 18 bundle và 8 sản phẩm hub phổ biến nhưng không thuộc bundle riêng.
function createCatalog(): SyntheticProduct[] {
    const products: SyntheticProduct[] = [];
    for (let bundleId = 0; bundleId < BUNDLE_COUNT; bundleId += 1) {
        for (
            let productIndex = 0;
            productIndex < PRODUCTS_PER_BUNDLE;
            productIndex += 1
        ) {
            const productId = `bundle-${bundleId}-item-${productIndex}`;
            const categoryId = `category-${bundleId % 6}`;
            const brandId = `brand-${(bundleId * 3 + productIndex) % 12}`;
            products.push({
                productId,
                bundleId,
                isHub: false,
                categoryId,
                brandId,
                candidate: createCandidateFixture(
                    productId,
                    categoryId,
                    brandId,
                ),
            });
        }
    }

    for (let hubIndex = 0; hubIndex < POPULAR_HUB_COUNT; hubIndex += 1) {
        const productId = `popular-hub-${hubIndex}`;
        products.push({
            productId,
            bundleId: null,
            isHub: true,
            categoryId: `category-${hubIndex % 6}`,
            brandId: `brand-${hubIndex % 12}`,
            candidate: createCandidateFixture(
                productId,
                `category-${hubIndex % 6}`,
                `brand-${hubIndex % 12}`,
            ),
        });
    }
    return products;
}

// Tạo candidate contract tối thiểu cho feature builder; phần test chỉ dùng product id/category/brand và feature relation.
function createCandidateFixture(
    productId: string,
    categoryId: string,
    brandId: string,
): RecommendationCandidate {
    const product = {
        productId,
        name: productId,
        slug: productId,
        imageUrl: null,
        categoryId,
        brandId,
        sellerShopId: 'synthetic-shop',
        minPrice: '1',
        maxPrice: '1',
        ratingAvg: '4',
        reviewCount: 10,
        totalSold: 0,
        status: 'ACTIVE',
        isInStock: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
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
    } as RecommendationCandidate['product'];

    return {
        product,
        sources: new Set(['CO_BEHAVIOR']),
        contributions: [],
    };
}

// Chọn bundle theo phân phối dài đuôi để mô phỏng nhóm sản phẩm có mức hoạt động khác nhau.
function chooseBundleId(state: RandomState): number {
    let totalWeight = 0;
    for (let bundleId = 0; bundleId < BUNDLE_COUNT; bundleId += 1) {
        totalWeight += 1 / Math.sqrt(bundleId + 1);
    }
    let draw = nextRandom(state) * totalWeight;
    for (let bundleId = 0; bundleId < BUNDLE_COUNT; bundleId += 1) {
        draw -= 1 / Math.sqrt(bundleId + 1);
        if (draw <= 0) return bundleId;
    }
    return BUNDLE_COUNT - 1;
}

// Chọn một sản phẩm hub theo phân phối lệch để vài mặt hàng xuất hiện cùng nhiều bundle.
function chooseHubProductId(state: RandomState): string {
    let totalWeight = 0;
    for (let hubIndex = 0; hubIndex < POPULAR_HUB_COUNT; hubIndex += 1) {
        totalWeight += 1 / Math.sqrt(hubIndex + 1);
    }
    let draw = nextRandom(state) * totalWeight;
    for (let hubIndex = 0; hubIndex < POPULAR_HUB_COUNT; hubIndex += 1) {
        draw -= 1 / Math.sqrt(hubIndex + 1);
        if (draw <= 0) return `popular-hub-${hubIndex}`;
    }
    return `popular-hub-${POPULAR_HUB_COUNT - 1}`;
}

// Chọn số lượng sản phẩm khác nhau trong bundle để basket không chứa trùng một item.
function chooseBundleItems(state: RandomState, bundleId: number): string[] {
    const targetCount = 3 + Math.floor(nextRandom(state) * 3);
    const selected = new Set<number>();
    while (selected.size < targetCount) {
        selected.add(Math.floor(nextRandom(state) * PRODUCTS_PER_BUNDLE));
    }
    return [...selected]
        .sort((left, right) => left - right)
        .map((productIndex) => `bundle-${bundleId}-item-${productIndex}`);
}

// Tạo một basket train với loại tín hiệu, độ nặng và thời điểm đều được sinh trước khi sinh request/test outcome.
function createTrainingBasket(
    basketIndex: number,
    state: RandomState,
): SyntheticBasket {
    const bundleId = chooseBundleId(state);
    const productIds = chooseBundleItems(state, bundleId);
    const basketTypeDraw = nextRandom(state);
    const relationType: RelationType =
        basketTypeDraw < 0.58
            ? 'CO_VIEW'
            : basketTypeDraw < 0.8
              ? 'CO_CART'
              : 'CO_PURCHASE';
    let scoreDelta: number;
    let returned = false;

    if (relationType === 'CO_VIEW') {
        const eventDraw = nextRandom(state);
        scoreDelta = eventDraw < 0.5 ? 1 : eventDraw < 0.85 ? 2 : 0.05;
    } else if (relationType === 'CO_CART') {
        scoreDelta = 3;
    } else {
        returned = nextRandom(state) < 0.08;
        scoreDelta = returned ? -6 : 6;
    }

    if (nextRandom(state) < 0.65) {
        productIds.push(chooseHubProductId(state));
    }

    // Một phần nhỏ basket có một mặt hàng nhiễu từ bundle khác để không biến tương quan thành quy tắc tuyệt đối.
    if (nextRandom(state) < 0.1) {
        const offset = 1 + Math.floor(nextRandom(state) * (BUNDLE_COUNT - 1));
        const noiseBundle = (bundleId + offset) % BUNDLE_COUNT;
        const noiseIndex = Math.floor(nextRandom(state) * PRODUCTS_PER_BUNDLE);
        productIds.push(`bundle-${noiseBundle}-item-${noiseIndex}`);
    }

    return {
        basketId: `train-${basketIndex}`,
        day: nextRandom(state) * 60,
        relationType,
        productIds: [...new Set(productIds)],
        scoreDelta,
        returned,
    };
}

// Ghi pair aggregate hai chiều như read model dự án; return trừ điểm và lần mới nhất cập nhật lastSignalDay.
function updatePairAggregate(
    aggregates: Map<string, PairAggregate>,
    relationType: RelationType,
    sourceProductId: string,
    targetProductId: string,
    scoreDelta: number,
    day: number,
): void {
    const key = relationKey(relationType, sourceProductId, targetProductId);
    const existing = aggregates.get(key);
    if (existing) {
        existing.score += scoreDelta;
        existing.lastSignalDay = Math.max(existing.lastSignalDay, day);
        return;
    }
    aggregates.set(key, { score: scoreDelta, lastSignalDay: day });
}

// Chuẩn hóa khóa pair để relation type, anchor và target không thể đè lên nhau trong map.
function relationKey(
    relationType: RelationType,
    sourceProductId: string,
    targetProductId: string,
): string {
    return `${relationType}\u0000${sourceProductId}\u0000${targetProductId}`;
}

// Thêm basket vào thống kê quan hệ, vector cosine và order counts chỉ khi event thuộc từng định nghĩa baseline.
function buildTrainingData(seed: number): {
    baskets: SyntheticBasket[];
    aggregates: Map<string, PairAggregate>;
    positiveCoEventBaskets: SyntheticBasket[];
    positivePurchaseBaskets: SyntheticBasket[];
} {
    const state = createRandomState(deriveSeed(seed, 'train-baskets'));
    const baskets: SyntheticBasket[] = [];
    const aggregates = new Map<string, PairAggregate>();
    const positiveCoEventBaskets: SyntheticBasket[] = [];
    const positivePurchaseBaskets: SyntheticBasket[] = [];

    for (
        let basketIndex = 0;
        basketIndex < TRAIN_BASKET_COUNT;
        basketIndex += 1
    ) {
        const basket = createTrainingBasket(basketIndex, state);
        baskets.push(basket);

        // Một basket trả hàng vẫn hiệu chỉnh production relation, nhưng không được coi là positive co-event trong cosine/order baseline.
        if (basket.relationType !== 'CO_PURCHASE' || !basket.returned) {
            positiveCoEventBaskets.push(basket);
        }
        if (basket.relationType === 'CO_PURCHASE' && !basket.returned) {
            positivePurchaseBaskets.push(basket);
        }

        for (
            let leftIndex = 0;
            leftIndex < basket.productIds.length;
            leftIndex += 1
        ) {
            const leftProductId = basket.productIds[leftIndex];
            if (!leftProductId) continue;
            for (
                let rightIndex = leftIndex + 1;
                rightIndex < basket.productIds.length;
                rightIndex += 1
            ) {
                const rightProductId = basket.productIds[rightIndex];
                if (!rightProductId) continue;
                updatePairAggregate(
                    aggregates,
                    basket.relationType,
                    leftProductId,
                    rightProductId,
                    basket.scoreDelta,
                    basket.day,
                );
                updatePairAggregate(
                    aggregates,
                    basket.relationType,
                    rightProductId,
                    leftProductId,
                    basket.scoreDelta,
                    basket.day,
                );
            }
        }
    }

    return {
        baskets,
        aggregates,
        positiveCoEventBaskets,
        positivePurchaseBaskets,
    };
}

// Sinh một request có hai anchor từ bundle ẩn; labels lấy từ luồng ngẫu nhiên riêng và không đọc bất kỳ ranker nào.
function createRequest(
    seed: number,
    split: SplitName,
    requestIndex: number,
    products: SyntheticProduct[],
    productById: Map<string, SyntheticProduct>,
): SyntheticRequest {
    const splitCode = split === 'validation' ? 1 : 2;
    const queryState = createRandomState(
        deriveSeed(seed, `query-${splitCode}-${requestIndex}`),
    );
    const labelState = createRandomState(
        deriveSeed(seed, `labels-${splitCode}-${requestIndex}`),
    );
    const bundleId = chooseBundleId(queryState);
    const firstIndex = Math.floor(nextRandom(queryState) * PRODUCTS_PER_BUNDLE);
    let secondIndex = Math.floor(nextRandom(queryState) * PRODUCTS_PER_BUNDLE);
    if (secondIndex === firstIndex) {
        secondIndex = (secondIndex + 1) % PRODUCTS_PER_BUNDLE;
    }
    const anchorProductIds = [
        `bundle-${bundleId}-item-${firstIndex}`,
        `bundle-${bundleId}-item-${secondIndex}`,
    ];
    const excluded = new Set(anchorProductIds);
    const candidateProductIds = products
        .map((product) => product.productId)
        .filter((productId) => !excluded.has(productId));
    const labels = new Map<string, number>();
    const tieBreakers = new Map<string, number>();

    // Outcomes depend only on the hidden bundle and product type; no coBehavior/cosine/count score enters this label rule.
    for (const productId of candidateProductIds) {
        const product = productById.get(productId);
        if (!product) throw new Error('SYNTHETIC_CATALOG_ITEM_MISSING');
        const clickProbability = product.isHub
            ? 0.12
            : product.bundleId === bundleId
              ? 0.42
              : 0.006;
        labels.set(
            productId,
            Number(nextRandom(labelState) < clickProbability),
        );
        tieBreakers.set(
            productId,
            stableTieBreaker(`${seed}:${split}:${requestIndex}:${productId}`),
        );
    }

    const startDay =
        split === 'validation' ? VALIDATION_START_DAY : TEST_START_DAY;
    const requestCount =
        split === 'validation' ? VALIDATION_REQUEST_COUNT : TEST_REQUEST_COUNT;
    const day =
        startDay + ((requestIndex + 0.5) / requestCount) * SPLIT_DURATION_DAYS;
    return {
        requestId: `${seed}-${split}-${requestIndex}`,
        day,
        split,
        intentBundleId: bundleId,
        anchorProductIds,
        candidateProductIds,
        labels,
        tieBreakers,
    };
}

// Tạo queries trong cùng catalog; validation/test khác thời điểm và chỉ nhận đúng cùng candidate/label set cho mọi công thức.
function createRequests(
    seed: number,
    split: SplitName,
    count: number,
    products: SyntheticProduct[],
    productById: Map<string, SyntheticProduct>,
): SyntheticRequest[] {
    const requests: SyntheticRequest[] = [];
    for (let requestIndex = 0; requestIndex < count; requestIndex += 1) {
        requests.push(
            createRequest(seed, split, requestIndex, products, productById),
        );
    }
    return requests;
}

// Kiểm tra bất biến thời gian trước khi dựng scorer để không dùng basket xảy ra sau cutoff của bất kỳ request nào.
function assertNoFutureHistory(
    baskets: SyntheticBasket[],
    requests: SyntheticRequest[],
): void {
    for (const request of requests) {
        for (const basket of baskets) {
            if (basket.day > request.day) {
                throw new Error(
                    `FUTURE_TRAIN_BASKET:${basket.basketId}:${request.requestId}`,
                );
            }
        }
    }
}

// Tạo lại config boundary cho RecommendationRuleService; multiplier chỉ đổi scale lúc chọn trên validation, không sửa service production.
function createRankingFeatureService(
    scaleMultiplier: number,
): RankingFeatureService {
    const config = {
        // Giữ mặc định mọi policy khác; chỉ thay ba scale relation để tuner xét một lưới công khai.
        get<T>(key: string, defaultValue?: T): T | undefined {
            if (key.startsWith('RECOMMENDATION_RELATION_SCALE_')) {
                const baseScale = Number(defaultValue);
                return String(baseScale * scaleMultiplier) as T;
            }
            return defaultValue;
        },
    };
    const rules = new RecommendationRuleService(
        config as unknown as ConfigService,
    );
    return new RankingFeatureService(rules);
}

// Chuyển tổng train pair thành effective score đúng dạng repository: tổng nhân half-life theo tuổi last_signal_at.
function getEffectiveRelationScore(
    aggregates: Map<string, PairAggregate>,
    relationType: RelationType,
    anchorProductId: string,
    candidateProductId: string,
    requestDay: number,
): number {
    const aggregate = aggregates.get(
        relationKey(relationType, anchorProductId, candidateProductId),
    );
    if (!aggregate) return 0;
    const ageDays = requestDay - aggregate.lastSignalDay;
    return aggregate.score * Math.pow(0.5, ageDays / RELATION_HALF_LIFE_DAYS);
}

// Lấy các contribution dương mà production relation candidate query có thể chuyển cho RankingFeatureService.
function createCoBehaviorCandidate(
    product: SyntheticProduct,
    request: SyntheticRequest,
    aggregates: Map<string, PairAggregate>,
): RecommendationCandidate {
    const contributions: NonNullable<RecommendationCandidate['contributions']> =
        [];
    for (const anchorProductId of request.anchorProductIds) {
        for (const relationType of RELATION_TYPES) {
            const rawScore = getEffectiveRelationScore(
                aggregates,
                relationType,
                anchorProductId,
                product.productId,
                request.day,
            );
            // Query production chỉ trả effective score dương; score âm/zero không tạo contribution dương cho ranker.
            if (rawScore <= 0 || !Number.isFinite(rawScore)) continue;
            contributions.push({
                source: 'CO_BEHAVIOR',
                rawScore,
                reasonCode: relationType,
                relationType,
                anchorProductId,
            });
        }
    }
    return {
        product: product.candidate.product,
        sources: new Set(['CO_BEHAVIOR']),
        contributions,
    };
}

// Tính feature coBehavior bằng đúng RankingFeatureService; các feature khác không tham gia phép đo này.
function productionFeatureScore(
    featureService: RankingFeatureService,
    product: SyntheticProduct,
    request: SyntheticRequest,
    aggregates: Map<string, PairAggregate>,
): number {
    const candidate = createCoBehaviorCandidate(product, request, aggregates);
    const emptyPreferences: never[] = [];
    const referenceTime = new Date(request.day * 86_400_000);
    return featureService.build(
        candidate,
        emptyPreferences,
        emptyPreferences,
        emptyPreferences,
        null,
        undefined,
        referenceTime,
    ).coBehavior;
}

// Raw-count baseline giữ nguyên pair weights, half-life và phép max production nhưng bỏ phép biến đổi bão hòa s/(s+k).
function rawCoOccurrenceScore(
    product: SyntheticProduct,
    request: SyntheticRequest,
    aggregates: Map<string, PairAggregate>,
): number {
    let bestScore = 0;
    for (const anchorProductId of request.anchorProductIds) {
        for (const relationType of RELATION_TYPES) {
            bestScore = Math.max(
                bestScore,
                getEffectiveRelationScore(
                    aggregates,
                    relationType,
                    anchorProductId,
                    product.productId,
                    request.day,
                ),
            );
        }
    }
    return Math.max(0, bestScore);
}

// Tạo cosine item-item từ vector basket binary; scope chỉ gồm train basket dương để không rò outcome validation/test.
function createCosineMatrix(
    products: SyntheticProduct[],
    positiveBaskets: SyntheticBasket[],
): Float64Array {
    const productIndexById = new Map<string, number>();
    for (let index = 0; index < products.length; index += 1) {
        const product = products[index];
        if (product) productIndexById.set(product.productId, index);
    }
    const scopesByProduct = products.map(() => new Set<number>());
    for (
        let basketIndex = 0;
        basketIndex < positiveBaskets.length;
        basketIndex += 1
    ) {
        const basket = positiveBaskets[basketIndex];
        if (!basket) continue;
        for (const productId of basket.productIds) {
            const productIndex = productIndexById.get(productId);
            if (productIndex === undefined) continue;
            scopesByProduct[productIndex]?.add(basketIndex);
        }
    }

    const matrix = new Float64Array(products.length * products.length);
    for (let leftIndex = 0; leftIndex < products.length; leftIndex += 1) {
        const leftScopes = scopesByProduct[leftIndex];
        if (!leftScopes) continue;
        for (
            let rightIndex = leftIndex;
            rightIndex < products.length;
            rightIndex += 1
        ) {
            const rightScopes = scopesByProduct[rightIndex];
            if (
                !rightScopes ||
                leftScopes.size === 0 ||
                rightScopes.size === 0
            ) {
                continue;
            }
            const smaller =
                leftScopes.size <= rightScopes.size ? leftScopes : rightScopes;
            const larger = smaller === leftScopes ? rightScopes : leftScopes;
            let intersection = 0;
            for (const scopeId of smaller) {
                if (larger.has(scopeId)) intersection += 1;
            }
            const similarity =
                intersection / Math.sqrt(leftScopes.size * rightScopes.size);
            matrix[leftIndex * products.length + rightIndex] = similarity;
            matrix[rightIndex * products.length + leftIndex] = similarity;
        }
    }
    return matrix;
}

// Tạo ma trận số đơn hàng positive và số cặp đồng mua; transaction trả hàng không được tính thành association dương.
function createPurchaseCounts(
    products: SyntheticProduct[],
    purchaseBaskets: SyntheticBasket[],
): {
    orderCount: number;
    itemCounts: Uint32Array;
    pairCounts: Uint32Array;
} {
    const productIndexById = new Map<string, number>();
    for (let index = 0; index < products.length; index += 1) {
        const product = products[index];
        if (product) productIndexById.set(product.productId, index);
    }
    const itemCounts = new Uint32Array(products.length);
    const pairCounts = new Uint32Array(products.length * products.length);

    for (const basket of purchaseBaskets) {
        const indices: number[] = [];
        for (const productId of basket.productIds) {
            const index = productIndexById.get(productId);
            if (index === undefined) continue;
            indices.push(index);
            itemCounts[index] = (itemCounts[index] ?? 0) + 1;
        }
        for (let left = 0; left < indices.length; left += 1) {
            const leftIndex = indices[left];
            if (leftIndex === undefined) continue;
            for (let right = left + 1; right < indices.length; right += 1) {
                const rightIndex = indices[right];
                if (rightIndex === undefined) continue;
                pairCounts[leftIndex * products.length + rightIndex] =
                    (pairCounts[leftIndex * products.length + rightIndex] ??
                        0) + 1;
                pairCounts[rightIndex * products.length + leftIndex] =
                    (pairCounts[rightIndex * products.length + leftIndex] ??
                        0) + 1;
            }
        }
    }

    return {
        orderCount: purchaseBaskets.length,
        itemCounts,
        pairCounts,
    };
}

// Lấy cosine lớn nhất từ các anchor để cùng một reducer được dùng khi request có nhiều sản phẩm mốc.
function itemCosineScore(
    product: SyntheticProduct,
    request: SyntheticRequest,
    productIndexById: Map<string, number>,
    matrix: Float64Array,
    productCount: number,
): number {
    const candidateIndex = productIndexById.get(product.productId);
    if (candidateIndex === undefined) return 0;
    let bestScore = 0;
    for (const anchorProductId of request.anchorProductIds) {
        const anchorIndex = productIndexById.get(anchorProductId);
        if (anchorIndex === undefined) continue;
        const similarity =
            matrix[anchorIndex * productCount + candidateIndex] ?? 0;
        bestScore = Math.max(bestScore, similarity);
    }
    return bestScore;
}

// Tính purchase confidence 또는 lift theo các order train, sau đó lấy max qua anchor để giữ phép gộp như production.
function purchaseAssociationScore(
    method: 'purchase-confidence' | 'purchase-lift',
    product: SyntheticProduct,
    request: SyntheticRequest,
    productIndexById: Map<string, number>,
    orderCount: number,
    itemCounts: Uint32Array,
    pairCounts: Uint32Array,
    productCount: number,
): number {
    const candidateIndex = productIndexById.get(product.productId);
    if (candidateIndex === undefined || orderCount === 0) return 0;
    let bestScore = 0;
    for (const anchorProductId of request.anchorProductIds) {
        const anchorIndex = productIndexById.get(anchorProductId);
        if (anchorIndex === undefined) continue;
        const anchorCount = itemCounts[anchorIndex] ?? 0;
        const candidateCount = itemCounts[candidateIndex] ?? 0;
        const pairCount =
            pairCounts[anchorIndex * productCount + candidateIndex] ?? 0;
        if (anchorCount === 0 || candidateCount === 0 || pairCount === 0) {
            continue;
        }
        const confidence = pairCount / anchorCount;
        const score =
            method === 'purchase-confidence'
                ? confidence
                : (pairCount * orderCount) / (anchorCount * candidateCount);
        bestScore = Math.max(bestScore, score);
    }
    return bestScore;
}

// Tạo tập history và statistic train-only rồi xác nhận mọi query cutoff muộn hơn toàn bộ event được dùng.
function createSeedDataset(seed: number): SeedDataset {
    const products = createCatalog();
    const productById = new Map(
        products.map((product) => [product.productId, product]),
    );
    const training = buildTrainingData(seed);
    const validationRequests = createRequests(
        seed,
        'validation',
        VALIDATION_REQUEST_COUNT,
        products,
        productById,
    );
    const testRequests = createRequests(
        seed,
        'test',
        TEST_REQUEST_COUNT,
        products,
        productById,
    );
    assertNoFutureHistory(training.baskets, validationRequests);
    assertNoFutureHistory(training.baskets, testRequests);
    const purchaseCounts = createPurchaseCounts(
        products,
        training.positivePurchaseBaskets,
    );
    const cosineMatrix = createCosineMatrix(
        products,
        training.positiveCoEventBaskets,
    );

    return {
        seed,
        products,
        productById,
        trainBaskets: training.baskets,
        validationRequests,
        testRequests,
        relationAggregates: training.aggregates,
        cosineMatrix,
        orderCount: purchaseCounts.orderCount,
        orderItemCounts: purchaseCounts.itemCounts,
        orderPairCounts: purchaseCounts.pairCounts,
    };
}

// Chấm một cặp request-item theo đúng một phương pháp; tất cả scorer nhận cùng anchors, candidate và train statistics.
function scoreCandidate(
    method: MethodName,
    dataset: SeedDataset,
    request: SyntheticRequest,
    product: SyntheticProduct,
    featureService: RankingFeatureService,
    productIndexById: Map<string, number>,
): number {
    if (
        method === 'production-default' ||
        method === 'production-tuned-scale'
    ) {
        return productionFeatureScore(
            featureService,
            product,
            request,
            dataset.relationAggregates,
        );
    }
    if (method === 'raw-co-occurrence') {
        return rawCoOccurrenceScore(
            product,
            request,
            dataset.relationAggregates,
        );
    }
    if (method === 'item-item-cosine') {
        return itemCosineScore(
            product,
            request,
            productIndexById,
            dataset.cosineMatrix,
            dataset.products.length,
        );
    }
    return purchaseAssociationScore(
        method,
        product,
        request,
        productIndexById,
        dataset.orderCount,
        dataset.orderItemCounts,
        dataset.orderPairCounts,
        dataset.products.length,
    );
}

// Tính NDCG@10, Recall@10 và score coverage trên cùng binary labels; NDCG giữ cả query không có positive.
function evaluateRanking(
    dataset: SeedDataset,
    requests: SyntheticRequest[],
    method: MethodName,
    featureService: RankingFeatureService,
): RankingMetrics {
    let ndcgTotal = 0;
    let recallTotal = 0;
    let positiveRequestCount = 0;
    let scoredCandidateCount = 0;
    let candidateCount = 0;
    let requestScoreCount = 0;
    const productIndexById = new Map<string, number>();
    for (let index = 0; index < dataset.products.length; index += 1) {
        const product = dataset.products[index];
        if (product) productIndexById.set(product.productId, index);
    }

    for (const request of requests) {
        const ranked: Array<{
            productId: string;
            score: number;
            tieBreaker: number;
        }> = [];
        let positiveCount = 0;
        let hasPositiveScore = false;
        for (const productId of request.candidateProductIds) {
            const product = dataset.productById.get(productId);
            if (!product) throw new Error('SYNTHETIC_CANDIDATE_NOT_FOUND');
            const score = scoreCandidate(
                method,
                dataset,
                request,
                product,
                featureService,
                productIndexById,
            );
            if (!Number.isFinite(score)) {
                throw new Error(`NON_FINITE_RANKING_SCORE:${method}`);
            }
            const label = request.labels.get(productId) ?? 0;
            positiveCount += label;
            if (score > 0) {
                scoredCandidateCount += 1;
                hasPositiveScore = true;
            }
            candidateCount += 1;
            ranked.push({
                productId,
                score,
                tieBreaker: request.tieBreakers.get(productId) ?? 0,
            });
        }

        // Stable score/hash/id ordering makes ties independent of candidate input order and host locale.
        ranked.sort((left, right) => {
            const scoreDifference = right.score - left.score;
            if (scoreDifference !== 0) return scoreDifference;
            const tieDifference = right.tieBreaker - left.tieBreaker;
            if (tieDifference !== 0) return tieDifference;
            return left.productId < right.productId
                ? -1
                : left.productId > right.productId
                  ? 1
                  : 0;
        });

        if (hasPositiveScore) requestScoreCount += 1;
        let dcg = 0;
        let hits = 0;
        for (let rank = 0; rank < CUTOFF; rank += 1) {
            const item = ranked[rank];
            if (!item || request.labels.get(item.productId) !== 1) continue;
            dcg += 1 / Math.log2(rank + 2);
            hits += 1;
        }
        let idealDcg = 0;
        const idealCount = Math.min(positiveCount, CUTOFF);
        for (let rank = 0; rank < idealCount; rank += 1) {
            idealDcg += 1 / Math.log2(rank + 2);
        }
        ndcgTotal += idealDcg === 0 ? 0 : dcg / idealDcg;
        if (positiveCount > 0) {
            recallTotal += hits / positiveCount;
            positiveRequestCount += 1;
        }
    }

    return {
        ndcgAt10: requests.length === 0 ? 0 : ndcgTotal / requests.length,
        recallAt10:
            positiveRequestCount === 0 ? 0 : recallTotal / positiveRequestCount,
        candidateScoreCoverage:
            candidateCount === 0 ? 0 : scoredCandidateCount / candidateCount,
        requestScoreCoverage:
            requests.length === 0 ? 0 : requestScoreCount / requests.length,
        requestCount: requests.length,
        positiveRequestCount,
    };
}

// Chọn scale multiplier bằng validation NDCG; nếu tie thì ưu tiên multiplier gần cấu hình production 1.
function selectScaleMultiplier(dataset: SeedDataset): {
    multiplier: number;
    metrics: RankingMetrics;
} {
    let bestMultiplier: number = SCALE_MULTIPLIERS[0];
    let bestMetrics: RankingMetrics | null = null;
    for (const multiplier of SCALE_MULTIPLIERS) {
        const metrics = evaluateRanking(
            dataset,
            dataset.validationRequests,
            'production-tuned-scale',
            createRankingFeatureService(multiplier),
        );
        if (!bestMetrics) {
            bestMultiplier = multiplier;
            bestMetrics = metrics;
            continue;
        }
        const ndcgDifference = metrics.ndcgAt10 - bestMetrics.ndcgAt10;
        const currentDistance = Math.abs(Math.log(multiplier));
        const bestDistance = Math.abs(Math.log(bestMultiplier));
        if (
            ndcgDifference > 1e-12 ||
            (Math.abs(ndcgDifference) <= 1e-12 &&
                currentDistance < bestDistance)
        ) {
            bestMultiplier = multiplier;
            bestMetrics = metrics;
        }
    }
    if (!bestMetrics)
        throw new Error('SCALE_MULTIPLIER_GRID_MUST_NOT_BE_EMPTY');
    return { multiplier: bestMultiplier, metrics: bestMetrics };
}

// Tính trung bình, sample standard deviation và min/max để thể hiện dao động qua các seed, không gọi đó là CI.
function calculateSpread(values: number[]): MetricSpread {
    if (values.length === 0) {
        return { mean: 0, standardDeviation: 0, minimum: 0, maximum: 0 };
    }
    let total = 0;
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    for (const value of values) {
        total += value;
        minimum = Math.min(minimum, value);
        maximum = Math.max(maximum, value);
    }
    const mean = total / values.length;
    let squaredDifferenceTotal = 0;
    for (const value of values) {
        squaredDifferenceTotal += (value - mean) ** 2;
    }
    const standardDeviation =
        values.length < 2
            ? 0
            : Math.sqrt(squaredDifferenceTotal / (values.length - 1));
    return { mean, standardDeviation, minimum, maximum };
}

// Gộp metric của các seed theo cùng phương pháp để báo mean ± sample SD và độ phủ test.
function summarizeMethodResults(results: SeedMethodResult[]): MethodSummary {
    return {
        validationNdcg: calculateSpread(
            results.map((result) => result.validation.ndcgAt10),
        ),
        testNdcg: calculateSpread(
            results.map((result) => result.test.ndcgAt10),
        ),
        testRecall: calculateSpread(
            results.map((result) => result.test.recallAt10),
        ),
        testCandidateCoverage: calculateSpread(
            results.map((result) => result.test.candidateScoreCoverage),
        ),
        testRequestCoverage: calculateSpread(
            results.map((result) => result.test.requestScoreCoverage),
        ),
    };
}

// Định dạng mean ± độ lệch chuẩn mẫu và giữ bốn chữ số để các lần chạy dễ đối chiếu.
function formatSpread(spread: MetricSpread): string {
    return `${spread.mean.toFixed(4)} ± ${spread.standardDeviation.toFixed(4)}`;
}

// Chạy nhiều seed; mỗi seed chọn scale riêng chỉ từ validation, rồi mở test đúng một lần cho default và tuned feature.
function runEvaluation(): void {
    const methodNames: MethodName[] = [
        'production-default',
        'production-tuned-scale',
        'raw-co-occurrence',
        'item-item-cosine',
        'purchase-confidence',
        'purchase-lift',
    ];
    const resultsByMethod = new Map<MethodName, SeedMethodResult[]>();
    const selectedScales = new Map<number, number>();

    for (const method of methodNames) resultsByMethod.set(method, []);
    for (const seed of SEEDS) {
        const dataset = createSeedDataset(seed);
        const selectedScale = selectScaleMultiplier(dataset);
        selectedScales.set(seed, selectedScale.multiplier);

        const defaultFeatureService = createRankingFeatureService(1);
        const tunedFeatureService = createRankingFeatureService(
            selectedScale.multiplier,
        );
        for (const method of methodNames) {
            if (!method) continue;
            const featureService =
                method === 'production-default'
                    ? defaultFeatureService
                    : method === 'production-tuned-scale'
                      ? tunedFeatureService
                      : defaultFeatureService;
            const validationMetrics =
                method === 'production-default'
                    ? evaluateRanking(
                          dataset,
                          dataset.validationRequests,
                          method,
                          defaultFeatureService,
                      )
                    : method === 'production-tuned-scale'
                      ? selectedScale.metrics
                      : evaluateRanking(
                            dataset,
                            dataset.validationRequests,
                            method,
                            featureService,
                        );
            const testMetrics = evaluateRanking(
                dataset,
                dataset.testRequests,
                method,
                featureService,
            );
            resultsByMethod.get(method)?.push({
                validation: validationMetrics,
                test: testMetrics,
            });
        }
    }

    printReport(resultsByMethod, selectedScales);
}

// In bảng metric và lựa chọn scale để báo protocol cùng kết quả mà không ghi file dữ liệu hoặc ảnh hưởng service.
function printReport(
    resultsByMethod: Map<MethodName, SeedMethodResult[]>,
    selectedScales: Map<number, number>,
): void {
    const methodLabels: Array<[MethodName, string]> = [
        ['production-default', 'Production coBehavior (k mặc định)'],
        ['production-tuned-scale', 'Production coBehavior (k chọn validation)'],
        ['raw-co-occurrence', 'Raw weighted co-occurrence'],
        ['item-item-cosine', 'Item-item cosine (train-only)'],
        ['purchase-confidence', 'Purchase confidence (train-only)'],
        ['purchase-lift', 'Purchase lift (train-only)'],
    ];

    process.stdout.write(
        'Tiêu chí 4 — synthetic coBehavior benchmark\n' +
            `Seeds: ${SEEDS.join(', ')}; train baskets/seed: ${TRAIN_BASKET_COUNT}; ` +
            `validation/test requests/seed: ${VALIDATION_REQUEST_COUNT}/${TEST_REQUEST_COUNT}.\n` +
            `Catalog: ${BUNDLE_COUNT * PRODUCTS_PER_BUNDLE + POPULAR_HUB_COUNT} items; ` +
            `2 anchors/request; same ${BUNDLE_COUNT * PRODUCTS_PER_BUNDLE + POPULAR_HUB_COUNT - 2} candidates/request; K=${CUTOFF}.\n` +
            `Time: train days 0–60; validation days ${VALIDATION_START_DAY}–${VALIDATION_START_DAY + SPLIT_DURATION_DAYS}; ` +
            `test days ${TEST_START_DAY}–${TEST_START_DAY + SPLIT_DURATION_DAYS}; half-life=${RELATION_HALF_LIFE_DAYS} days.\n` +
            `Scale tuning: NDCG@10 on validation only; grid=${SCALE_MULTIPLIERS.join(', ')}; ` +
            'production default remains multiplier=1.\n' +
            `Selected scale multipliers by seed: ${[...selectedScales.entries()]
                .map(([seed, multiplier]) => `${seed}:${multiplier}`)
                .join(', ')}.\n` +
            'Labels are sampled from hidden bundle intent, not any compared score; no AI model is trained.\n\n',
    );
    process.stdout.write(
        '| Method | Validation NDCG@10 | Test NDCG@10 | Test Recall@10 | Test candidate score coverage | Test request score coverage |\n' +
            '| --- | ---: | ---: | ---: | ---: | ---: |\n',
    );

    for (const [method, label] of methodLabels) {
        const seedResults = resultsByMethod.get(method) ?? [];
        const summary = summarizeMethodResults(seedResults);
        process.stdout.write(
            `| ${label} | ${formatSpread(summary.validationNdcg)} | ${formatSpread(summary.testNdcg)} | ${formatSpread(summary.testRecall)} | ${formatSpread(summary.testCandidateCoverage)} | ${formatSpread(summary.testRequestCoverage)} |\n`,
        );
    }

    process.stdout.write(
        '\nSD is sample standard deviation across deterministic seeds, not a confidence interval. ' +
            'Candidate score coverage is the fraction of request-item rows with score > 0; request coverage is the fraction of requests with at least one nonzero candidate score.\n',
    );
}

// Chạy đồng bộ để build output có thể thực thi bằng một lệnh Node và báo lỗi qua mã thoát của tiến trình.
function main(): void {
    try {
        runEvaluation();
    } catch (error) {
        const message =
            error instanceof Error ? error.message : 'UNKNOWN_EVALUATION_ERROR';
        process.stderr.write(`Criterion 4 evaluator failed: ${message}\n`);
        process.exitCode = 1;
    }
}

main();
