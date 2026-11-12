// Script này mô phỏng policy chọn item tuần tự trên môi trường synthetic có seed.
// Nó không biến cờ exploration production thành policy, không sửa scoring và không chứng minh hiệu quả với người mua thật.

type PolicyName = 'greedy-no-exploration' | 'epsilon-greedy' | 'ucb1-pooled';

interface Scenario {
    seed: number;
    contexts: number[];
    categories: number[];
    probabilities: number[][];
    averageProbabilities: number[];
    potentialRewards: number[][];
    warmupRewards: number[][];
}

interface PolicyRun {
    seed: number;
    cumulativeReward: number;
    cumulativePseudoRegret: number;
    uniqueItems: number;
    uniqueCategories: number;
    randomizedBranchCount: number;
    nonGreedyChoiceCount: number;
}

interface Interval {
    mean: number;
    lower95: number;
    upper95: number;
}

interface Summary {
    trials: number;
    roundsPerTrial: number;
    meanCumulativeReward: number;
    meanRewardPerAction: number;
    meanCumulativePseudoRegret: number;
    meanPseudoRegretPerAction: number;
    meanUniqueItems: number;
    meanCatalogCoverage: number;
    meanUniqueCategories: number;
    meanRandomizedBranchRate: number | null;
    meanNonGreedyChoiceRate: number;
}

const ITEM_COUNT = 16;
const CONTEXT_COUNT = 4;
const WARMUP_PER_ITEM = 20;
const ROUNDS_PER_TRIAL = 2_000;
const VALIDATION_SEEDS = Array.from({ length: 20 }, (_, index) => 501 + index);
const TEST_SEEDS = Array.from({ length: 30 }, (_, index) => 1_001 + index);
const EPSILON_GRID = [0.02, 0.05, 0.1, 0.2, 0.3];
const BOOTSTRAP_REPLICATES = 2_000;

// PRNG xác định giúp mọi kịch bản, reward và nhánh chọn ngẫu nhiên tái lập được.
function createRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state += 0x6d2b79f5;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
    };
}

// Tách seed theo policy để số lần gọi PRNG trong một thuật toán không làm đổi môi trường reward.
function policySeed(seed: number, policy: PolicyName): number {
    let hash = seed >>> 0;
    for (const character of policy) {
        hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619);
    }
    return hash >>> 0;
}

// Xáo danh mục ẩn để item ID và tie-break cố định không tiết lộ arm có reward cao.
function shuffle(values: number[], random: () => number): void {
    for (let index = values.length - 1; index > 0; index -= 1) {
        const other = Math.floor(random() * (index + 1));
        [values[index], values[other]] = [values[other]!, values[index]!];
    }
}

// Sinh cùng context, xác suất reward tiềm năng và warm-up cho mọi policy của một seed.
// Reward phụ thuộc category-match ẩn và quality ngẫu nhiên, không phụ thuộc điểm policy.
function createScenario(seed: number): Scenario {
    const random = createRandom(seed);
    const categories = Array.from(
        { length: ITEM_COUNT },
        (_, index) => index % CONTEXT_COUNT,
    );
    shuffle(categories, random);

    const itemQualities = categories.map(() => 0.15 + random() * 0.12);
    const probabilities = Array.from({ length: CONTEXT_COUNT }, (_, context) =>
        categories.map((category, item) => {
            const itemQuality = itemQualities[item]!;
            const preference =
                category === context ? 0.48 + random() * 0.2 : random() * 0.2;
            return Math.min(0.95, itemQuality + preference);
        }),
    );
    const averageProbabilities = categories.map(
        (_, item) =>
            probabilities.reduce((sum, row) => sum + row[item]!, 0) /
            CONTEXT_COUNT,
    );

    // Warm-up cố định cung cấp cùng 20 quan sát/item; sau đó greedy không chủ động thử item mới.
    const warmupRewards = categories.map((_, item) =>
        Array.from({ length: WARMUP_PER_ITEM }, () => {
            const context = Math.floor(random() * CONTEXT_COUNT);
            return Number(random() < probabilities[context]![item]!);
        }),
    );
    const contexts = Array.from({ length: ROUNDS_PER_TRIAL }, () =>
        Math.floor(random() * CONTEXT_COUNT),
    );
    const potentialRewards = contexts.map((context) =>
        categories.map((_, item) =>
            Number(random() < probabilities[context]![item]!),
        ),
    );

    return {
        seed,
        contexts,
        categories,
        probabilities,
        averageProbabilities,
        potentialRewards,
        warmupRewards,
    };
}

// Chọn score lớn nhất, giữ tie-break theo item ID để greedy hoàn toàn xác định.
function firstMaximum(scores: number[]): number {
    let best = 0;
    for (let index = 1; index < scores.length; index += 1) {
        if (scores[index]! > scores[best]!) best = index;
    }
    return best;
}

// Tính empirical mean từ dữ liệu warm-up chung và reward đã quan sát sau mỗi action.
function empiricalMeans(counts: number[], rewardSums: number[]): number[] {
    return counts.map((count, item) => rewardSums[item]! / count);
}

// Chạy policy context-agnostic: context hiện tại chi phối reward nhưng policy không được đọc context.
// Greedy chỉ khai thác warm-up; epsilon-greedy thỉnh thoảng chọn arm ngẫu nhiên; UCB1 dùng bonus bất định.
function runPolicy(
    scenario: Scenario,
    policy: PolicyName,
    epsilon = 0,
): PolicyRun {
    const random = createRandom(policySeed(scenario.seed, policy));
    const counts = Array<number>(ITEM_COUNT).fill(WARMUP_PER_ITEM);
    const rewardSums = scenario.warmupRewards.map((rewards) =>
        rewards.reduce((sum, value) => sum + value, 0),
    );
    const seenItems = new Set<number>();
    const seenCategories = new Set<number>();
    const bestFixedArmMean = Math.max(...scenario.averageProbabilities);
    let cumulativeReward = 0;
    let cumulativePseudoRegret = 0;
    let randomizedBranchCount = 0;
    let nonGreedyChoiceCount = 0;

    for (let round = 0; round < scenario.contexts.length; round += 1) {
        const means = empiricalMeans(counts, rewardSums);
        const greedyChoice = firstMaximum(means);
        let chosen = greedyChoice;

        if (policy === 'epsilon-greedy' && random() < epsilon) {
            chosen = Math.floor(random() * ITEM_COUNT);
            randomizedBranchCount += 1;
        } else if (policy === 'ucb1-pooled') {
            const totalPulls = counts.reduce((sum, count) => sum + count, 0);
            const ucbScores = means.map(
                (mean, item) =>
                    mean +
                    Math.sqrt((2 * Math.log(totalPulls)) / counts[item]!),
            );
            chosen = firstMaximum(ucbScores);
        }

        if (chosen !== greedyChoice) nonGreedyChoiceCount += 1;
        // Policy chọn action trước; chỉ reward của item đã chọn được quan sát và cập nhật vào thống kê.
        cumulativeReward += scenario.potentialRewards[round]![chosen]!;
        // Pseudo-regret dùng mean arm dưới phân phối context đồng nhất; comparator là arm cố định tốt nhất.
        cumulativePseudoRegret +=
            bestFixedArmMean - scenario.averageProbabilities[chosen]!;
        counts[chosen] = counts[chosen]! + 1;
        rewardSums[chosen] =
            rewardSums[chosen]! + scenario.potentialRewards[round]![chosen]!;
        seenItems.add(chosen);
        seenCategories.add(scenario.categories[chosen]!);
    }

    return {
        seed: scenario.seed,
        cumulativeReward,
        cumulativePseudoRegret,
        uniqueItems: seenItems.size,
        uniqueCategories: seenCategories.size,
        randomizedBranchCount,
        nonGreedyChoiceCount,
    };
}

// Trung bình mảng số; mảng rỗng được xử lý để báo cáo không sinh NaN.
function average(values: number[]): number {
    return values.length
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : 0;
}

// Làm tròn đầu ra JSON, không can thiệp vào phép chọn epsilon hoặc bootstrap.
function rounded(value: number): number {
    return Math.round(value * 10_000) / 10_000;
}

// Tóm tắt policy; tỷ lệ random branch chỉ áp dụng cho epsilon-greedy.
function summarize(runs: PolicyRun[], policy: PolicyName): Summary {
    return {
        trials: runs.length,
        roundsPerTrial: ROUNDS_PER_TRIAL,
        meanCumulativeReward: rounded(
            average(runs.map((run) => run.cumulativeReward)),
        ),
        meanRewardPerAction: rounded(
            average(runs.map((run) => run.cumulativeReward / ROUNDS_PER_TRIAL)),
        ),
        meanCumulativePseudoRegret: rounded(
            average(runs.map((run) => run.cumulativePseudoRegret)),
        ),
        meanPseudoRegretPerAction: rounded(
            average(
                runs.map(
                    (run) => run.cumulativePseudoRegret / ROUNDS_PER_TRIAL,
                ),
            ),
        ),
        meanUniqueItems: rounded(average(runs.map((run) => run.uniqueItems))),
        meanCatalogCoverage: rounded(
            average(runs.map((run) => run.uniqueItems / ITEM_COUNT)),
        ),
        meanUniqueCategories: rounded(
            average(runs.map((run) => run.uniqueCategories)),
        ),
        meanRandomizedBranchRate:
            policy === 'epsilon-greedy'
                ? rounded(
                      average(
                          runs.map(
                              (run) =>
                                  run.randomizedBranchCount / ROUNDS_PER_TRIAL,
                          ),
                      ),
                  )
                : null,
        meanNonGreedyChoiceRate: rounded(
            average(
                runs.map((run) => run.nonGreedyChoiceCount / ROUNDS_PER_TRIAL),
            ),
        ),
    };
}

// Bootstrap paired deltas theo seed test, giữ cặp policy cùng môi trường để giảm nhiễu giữa kịch bản.
function pairedInterval(deltas: number[], seed: number): Interval {
    const random = createRandom(seed);
    const samples = Array.from({ length: BOOTSTRAP_REPLICATES }, () =>
        average(
            Array.from(
                { length: deltas.length },
                () => deltas[Math.floor(random() * deltas.length)]!,
            ),
        ),
    ).sort((left, right) => left - right);
    return {
        mean: rounded(average(deltas)),
        lower95: rounded(
            samples[Math.floor((BOOTSTRAP_REPLICATES - 1) * 0.025)] ?? 0,
        ),
        upper95: rounded(
            samples[Math.floor((BOOTSTRAP_REPLICATES - 1) * 0.975)] ?? 0,
        ),
    };
}

// Chọn epsilon theo reward validation; nếu bằng điểm, thứ tự grid giữ epsilon nhỏ hơn.
function selectEpsilon(scenarios: Scenario[]): {
    selected: number;
    validation: Array<{ epsilon: number; rewardPerAction: number }>;
} {
    const validation = EPSILON_GRID.map((epsilon) => ({
        epsilon,
        rewardPerAction: average(
            scenarios.map(
                (scenario) =>
                    runPolicy(scenario, 'epsilon-greedy', epsilon)
                        .cumulativeReward / ROUNDS_PER_TRIAL,
            ),
        ),
    }));
    const selected = validation.reduce((best, candidate) =>
        candidate.rewardPerAction > best.rewardPerAction ? candidate : best,
    ).epsilon;
    return { selected, validation };
}

// Tính reward/regret paired delta so với greedy no-exploration trên cùng seed hold-out.
function compare(
    greedy: PolicyRun[],
    candidate: PolicyRun[],
    policy: PolicyName,
): object {
    const rewardDelta = candidate.map(
        (run, index) =>
            (run.cumulativeReward - greedy[index]!.cumulativeReward) /
            ROUNDS_PER_TRIAL,
    );
    const regretReduction = candidate.map(
        (run, index) =>
            (greedy[index]!.cumulativePseudoRegret -
                run.cumulativePseudoRegret) /
            ROUNDS_PER_TRIAL,
    );
    return {
        policy,
        rewardPerActionDeltaVsGreedy: pairedInterval(
            rewardDelta,
            policySeed(92_701, policy),
        ),
        pseudoRegretReductionPerActionVsGreedy: pairedInterval(
            regretReduction,
            policySeed(92_702, policy),
        ),
    };
}

// Tuning chỉ dùng validation seeds; kết quả chính và paired intervals chỉ dùng test seeds đã khóa trước.
function main(): void {
    const validationScenarios = VALIDATION_SEEDS.map(createScenario);
    const testScenarios = TEST_SEEDS.map(createScenario);
    const epsilon = selectEpsilon(validationScenarios);
    const testRuns: Record<PolicyName, PolicyRun[]> = {
        'greedy-no-exploration': testScenarios.map((scenario) =>
            runPolicy(scenario, 'greedy-no-exploration'),
        ),
        'epsilon-greedy': testScenarios.map((scenario) =>
            runPolicy(scenario, 'epsilon-greedy', epsilon.selected),
        ),
        'ucb1-pooled': testScenarios.map((scenario) =>
            runPolicy(scenario, 'ucb1-pooled'),
        ),
    };
    const greedyRuns = testRuns['greedy-no-exploration'];

    process.stdout.write(
        `${JSON.stringify(
            {
                title: 'Synthetic sequential exploration-policy simulation; not a production feature evaluation',
                productionComparison: {
                    status: 'unavailable',
                    reason: 'The production exploration indicator is an input feature to LambdaRank, not an action policy. Candidate source order plus the learned model jointly determine the served slate, so this simulator has no defensible mapping to the deployed policy.',
                    indicator:
                        '1 when profileAffinity <= 0.4 and source includes EXPLORE or NEWEST; otherwise 0',
                    sourceOrdering: {
                        EXPLORE: 'product_id ASC',
                        NEWEST: 'created_at DESC then product_id ASC',
                    },
                    rewardRegretMetrics: null,
                    requiredProductionEvaluation:
                        'Feature ablation in LambdaRank using temporally split impression logs; policy evaluation requires exposure/action and propensity logs or an online experiment.',
                },
                protocol: {
                    items: ITEM_COUNT,
                    discreteContextCount: CONTEXT_COUNT,
                    roundsPerTrial: ROUNDS_PER_TRIAL,
                    sharedWarmupObservationsPerItem: WARMUP_PER_ITEM,
                    validationSeeds: VALIDATION_SEEDS,
                    testSeeds: TEST_SEEDS,
                    rewardGeneration:
                        'Stationary Bernoulli potential rewards generated before policy execution. Probability is hidden item quality plus a context/category-match signal. It is independent of the compared policy scores.',
                    informationBoundary:
                        'All policies receive identical warm-up observations. The policy selector is context-agnostic and only sees chosen-item rewards; context affects potential reward but is not supplied to the policy.',
                    regret: 'Pseudo-regret against the best fixed item under the uniform context mixture; UCB1 therefore uses pooled arm statistics and is not contextual UCB/LinUCB.',
                    metrics: {
                        observedReward:
                            'Cumulative binary reward and reward/action.',
                        pseudoRegret:
                            'Cumulative expected gap to best fixed arm.',
                        coverage: 'Distinct item and category exposure.',
                        ndcgRecall:
                            'Not applicable: one item is selected per round; there is no ranked slate or held-out relevance set.',
                    },
                },
                epsilonTuning: {
                    grid: epsilon.validation,
                    selectedOnValidation: epsilon.selected,
                },
                testResults: Object.fromEntries(
                    Object.entries(testRuns).map(([policy, runs]) => [
                        policy,
                        summarize(runs, policy as PolicyName),
                    ]),
                ),
                pairedComparisonsVsGreedy: [
                    compare(
                        greedyRuns,
                        testRuns['epsilon-greedy'],
                        'epsilon-greedy',
                    ),
                    compare(greedyRuns, testRuns['ucb1-pooled'], 'ucb1-pooled'),
                ],
                limitations: [
                    'Synthetic policy experiment only; no real-user effectiveness claim and no inference about production LambdaRank.',
                    'The synthetic context signal is known to the environment but hidden from these policies; this intentionally tests pooled exploration, not contextual personalization.',
                    'The binary production feature cannot receive standalone reward/regret metrics; an actual LambdaRank feature ablation still needs impression/training data and a temporal split.',
                    'Warm-up, reward probabilities, item count and horizon are simulator assumptions, not research-proven project parameters.',
                ],
            },
            null,
            2,
        )}\n`,
    );
}

main();
