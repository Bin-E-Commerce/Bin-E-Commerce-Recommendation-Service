// Service này cung cấp profile data cho ranking và điều phối guest-to-user merge mà không biết persistence details.

import { Injectable } from '@nestjs/common';
import { RecommendationRedisService } from '@/infrastructure/redis/redis.module';
import { SessionContextService } from '@/modules/profiles/application/services/session/session-context.service';
import type { PreferenceValue } from '@/modules/profiles/application/types/profile.types';
import { ProfileQueryRepository } from '@/modules/profiles/infrastructure/repositories/profile-query.repository';
import { RecommendationRuleService } from '@/modules/profiles/application/services/rules/recommendation-rule.service';

// Application service giữ boundary giữa recommendation use case và profile persistence/cache.
@Injectable()
export class ProfileQueryService {
    constructor(
        private readonly repository: ProfileQueryRepository,
        private readonly redis: RecommendationRedisService,
        private readonly sessionContext: SessionContextService,
        private readonly rules: RecommendationRuleService,
    ) {}

    // Lấy top positive và negative preference riêng theo dimension để return/refund mạnh
    // không đẩy hết tín hiệu tích cực ra khỏi feature set của ranker.
    async getTop(
        actorType: 'USER' | 'SESSION',
        actorId: string,
        dimension: string,
        limit = 12,
    ): Promise<PreferenceValue[]> {
        const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 50);
        const referenceTime = new Date();
        const halfLife = this.rules.getProfileHalfLifeDays();
        const values = await this.repository.findTop(
            actorType,
            actorId,
            dimension,
            safeLimit,
            halfLife,
            referenceTime,
        );
        const now = referenceTime.getTime();
        // Xếp riêng hai tổng theo giá trị ở thời điểm đọc, không dùng score legacy.
        const sortByEffectiveMagnitude = (
            left: PreferenceValue,
            right: PreferenceValue,
            polarity: 'positive' | 'negative',
        ): number => {
            const leftScore = this.effectiveScore(
                left,
                now,
                halfLife,
                polarity,
            );
            const rightScore = this.effectiveScore(
                right,
                now,
                halfLife,
                polarity,
            );
            return (
                rightScore - leftScore ||
                right.lastSignalAt.getTime() - left.lastSignalAt.getTime() ||
                left.dimensionKey.localeCompare(right.dimensionKey)
            );
        };
        const positive = values
            .filter((value) => value.positiveScore > 0)
            .sort((left, right) =>
                sortByEffectiveMagnitude(left, right, 'positive'),
            )
            .slice(0, safeLimit);
        const negative = values
            .filter((value) => value.negativeScore > 0)
            .sort((left, right) =>
                sortByEffectiveMagnitude(left, right, 'negative'),
            )
            .slice(0, safeLimit);
        return [
            ...new Map(
                [...positive, ...negative].map((value) => [
                    value.dimensionKey,
                    value,
                ]),
            ).values(),
        ];
    }

    // So sánh riêng từng cực tính sau decay; score legacy không còn quyết định top preference.
    private effectiveScore(
        value: PreferenceValue,
        now: number,
        halfLife: number,
        polarity: 'positive' | 'negative',
    ): number {
        const ageDays = Math.max(
            0,
            (now - value.lastSignalAt.getTime()) / 86_400_000,
        );
        const score =
            polarity === 'positive' ? value.positiveScore : value.negativeScore;
        return score * Math.pow(0.5, ageDays / halfLife);
    }

    // Merge guest profile qua repository transaction rồi dọn Redis sau khi persistence hoàn tất.
    async mergeGuestSession(
        userId: string,
        sessionId: string,
    ): Promise<{ merged: boolean }> {
        const context = await this.sessionContext.get(sessionId);
        const merged = await this.repository.mergeGuestSession(
            userId,
            sessionId,
            this.rules.getProfileHalfLifeDays(),
            context ?? undefined,
        );
        // Chỉ xóa session sau khi transaction durable thành công; nếu chưa merge thì giữ context để retry không mất hành vi.
        if (merged) {
            await this.sessionContext.invalidate(sessionId);
            await this.redis.invalidateActor('user', userId);
        }
        return { merged };
    }
}
