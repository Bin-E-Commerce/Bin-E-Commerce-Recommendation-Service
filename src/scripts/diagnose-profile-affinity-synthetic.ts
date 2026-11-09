// Phép đo synthetic kiểm tra tác động của decay từng event trong hai kịch bản sở thích đổi và ổn định.
// Lịch sử được dựng theo kịch bản, không phải quan sát khách hàng; thứ tự điểm không chứng minh hiệu quả thực tế.

import { ConfigService } from '@nestjs/config';
import { RecommendationRuleService } from '@/modules/profiles/application/services/rules/recommendation-rule.service';
import type { PreferenceValue } from '@/modules/profiles/application/types/profile.types';
import { RankingFeatureService } from '@/modules/recommendation/application/services/ranking/features/ranking-feature.service';
import type { RecommendationCandidate } from '@/modules/recommendation/application/types/ranking/ranking.types';

const referenceTime = new Date('2026-11-09T00:00:00.000Z');

// Dựng candidate tối thiểu qua đúng feature builder production; các feature khác không dùng làm điểm đo.
function candidate(productId: string): RecommendationCandidate {
    return {
        product: {
            productId,
            categoryId: null,
            brandId: null,
            totalSold: 0,
            createdAt: referenceTime,
            ratingAvg: null,
            reviewCount: 0,
            isInStock: true,
        } as RecommendationCandidate['product'],
        sources: new Set(),
        contributions: [],
    };
}

// Tổng tại mốc hiện tại là kết quả trực tiếp của công thức từng event; score cũ chỉ dùng cho baseline.
function preference(
    productId: string,
    rawScore: number,
    decayedScore: number,
): PreferenceValue {
    return {
        actorType: 'USER',
        actorId: 'synthetic-user',
        dimension: 'PRODUCT',
        dimensionKey: productId,
        score: rawScore,
        positiveScore: decayedScore,
        negativeScore: 0,
        interactionCount: 2,
        lastSignalAt: referenceTime,
    };
}

// PRNG cố định để chạy lại cùng tập ca; không dùng seed để chọn tham số theo kết quả.
function randomGenerator(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4_294_967_296;
    };
}

// Giữ kết quả hòa nguyên trạng vì phá hòa ngẫu nhiên có thể làm sai lệch kết luận.
function preferredProduct(scoreA: number, scoreB: number): 'A' | 'B' | 'tie' {
    if (Math.abs(scoreA - scoreB) < 1e-12) return 'tie';
    return scoreA > scoreB ? 'A' : 'B';
}

// Xếp đúng cùng hai candidate bằng baseline và feature builder mới với lịch sử được truyền vào.
// Nhãn của kịch bản không tham gia phép tính điểm; trường hợp hòa được ghi riêng.
function compareHistory(
    features: RankingFeatureService,
    oldPurchaseCount: number,
    ageDays: number,
    recentA: number,
    recentB: number,
): { old: 'A' | 'B' | 'tie'; current: 'A' | 'B' | 'tie' } {
    const rawA = oldPurchaseCount * 8 + recentA;
    const decayedA =
        oldPurchaseCount * 8 * Math.pow(0.5, ageDays / 7) + recentA;
    const a = preference('A', rawA, decayedA);
    const b = preference('B', recentB, recentB);
    const currentA = features.build(
        candidate('A'),
        [a, b],
        [],
        [],
        null,
        undefined,
        referenceTime,
    ).profileAffinity;
    const currentB = features.build(
        candidate('B'),
        [a, b],
        [],
        [],
        null,
        undefined,
        referenceTime,
    ).profileAffinity;
    const oldA = Math.min(1, rawA / 8);
    const oldB = Math.min(1, recentB / 8);
    return {
        old: preferredProduct(oldA, oldB),
        current: preferredProduct(currentA, currentB),
    };
}

// Đo hai lịch sử khác nhau: ca ổn định có tín hiệu mới mạnh cho A, ca đổi sở thích có tín hiệu mới mạnh cho B.
// Kết quả chỉ mô tả thứ tự điểm trên dữ liệu dựng sẵn, không phải accuracy với khách hàng thật.
function evaluate(): void {
    const config = {
        get: (_key: string, fallback?: string) => fallback,
    } as ConfigService;
    const features = new RankingFeatureService(
        new RecommendationRuleService(config),
    );
    const runs = 1000;
    const counts = {
        switched: {
            old: { A: 0, B: 0, tie: 0 },
            current: { A: 0, B: 0, tie: 0 },
        },
        stable: {
            old: { A: 0, B: 0, tie: 0 },
            current: { A: 0, B: 0, tie: 0 },
        },
    };

    for (let seed = 1; seed <= runs; seed += 1) {
        const random = randomGenerator(seed);
        const oldPurchaseCount = 1 + Math.floor(random() * 4);
        const ageDays = 7 + Math.floor(random() * 24);
        const weakRecentSignal = random() < 0.5 ? 0.05 : 1;
        const competingSignal = random() < 0.5 ? 4 : 8;
        // Khi sở thích đổi, A chỉ còn tín hiệu mới yếu và B nhận tín hiệu mới mạnh.
        const switched = compareHistory(
            features,
            oldPurchaseCount,
            ageDays,
            weakRecentSignal,
            competingSignal,
        );
        counts.switched.old[switched.old] += 1;
        counts.switched.current[switched.current] += 1;

        // Khi sở thích ổn định, chính A nhận tín hiệu mới mạnh; B chỉ có tín hiệu yếu.
        const stable = compareHistory(
            features,
            oldPurchaseCount,
            ageDays,
            competingSignal,
            weakRecentSignal,
        );
        counts.stable.old[stable.old] += 1;
        counts.stable.current[stable.current] += 1;
    }

    process.stdout.write(
        `${JSON.stringify(
            {
                kind: 'controlled-synthetic-scenario',
                seeds: [1, runs],
                runsPerScenario: runs,
                metric: 'score ordering: A/B/tie',
                counts,
            },
            null,
            2,
        )}\n`,
    );
}

evaluate();
