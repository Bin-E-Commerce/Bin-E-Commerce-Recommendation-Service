// Application service cho Admin Recommendation Center; kiểm tra input, quyền nghiệp vụ policy và gọi repository read/write.

import {
    BadRequestException,
    Injectable,
} from '@nestjs/common';
import { RecommendationRuleService } from '@/modules/profiles/application/services/rules/recommendation-rule.service';
import { RecommendationAdminRepository } from '@/modules/admin-recommendation/infrastructure/repositories/recommendation-admin.repository';
import type {
    RecommendationAnalyticsQuery,
    RecommendationActorQuery,
    RecommendationPolicyRuntimeStatus,
} from '@/modules/admin-recommendation/application/types/admin-recommendation.types';
import { RecommendationAccountDirectoryClient } from '@/modules/admin-recommendation/infrastructure/clients/recommendation-account-directory.client';
import { RecommendationMlRankingService } from '@/modules/recommendation/application/services/ranking/ml/recommendation-ml-ranking.service';

@Injectable()
export class AdminRecommendationService {
    constructor(
        private readonly repository: RecommendationAdminRepository,
        private readonly rules: RecommendationRuleService,
        private readonly accountDirectory: RecommendationAccountDirectoryClient,
        private readonly mlRanking: RecommendationMlRankingService,
    ) {}

    // Trả KPI và top product trong cửa sổ tối đa 31 ngày để dashboard phản hồi ổn định.
    getOverview(query: RecommendationAnalyticsQuery) {
        return this.repository.getOverview(query.from, query.to);
    }

    // Ghép aggregate với account projection để UI không phải hiển thị UUID hoặc tự gọi Auth Service.
    async listActors(query: RecommendationActorQuery) {
        const profiles = query.search?.trim()
            ? await this.accountDirectory.findProfiles({ search: query.search })
            : [];
        if (query.search?.trim() && profiles.length === 0) {
            return {
                items: [],
                page: query.page,
                pageSize: query.pageSize,
                total: 0,
            };
        }

        const actorIds =
            profiles.length > 0
                ? profiles.map((profile) => profile.keycloakId)
                : undefined;
        const result = await this.repository.listActors(
            query.from,
            query.to,
            query.page,
            query.pageSize,
            query.actorType,
            actorIds,
        );
        const resolvedProfiles =
            profiles.length > 0
                ? profiles
                : await this.accountDirectory.findProfiles({
                      ids: result.items.map((actor) => actor.actorId),
                  });
        const profileById = new Map(
            resolvedProfiles.map((profile) => [profile.keycloakId, profile]),
        );

        return {
            ...result,
            items: result.items.map((actor) => ({
                ...actor,
                account: profileById.get(actor.actorId) ?? null,
            })),
        };
    }

    // Activity chỉ cho user ID đã xác thực từ Gateway; pagination bounded để tránh endpoint trở thành luồng export dữ liệu.
    getUserActivity(
        userId: string,
        page = 1,
        pageSize = 10,
        query?: RecommendationAnalyticsQuery,
    ) {
        if (!userId.trim())
            throw new BadRequestException('User ID is required');
        return this.repository.getUserActivity(
            userId.trim(),
            Math.min(Math.max(page, 1), 1000),
            Math.min(Math.max(pageSize, 1), 50),
            query?.from,
            query?.to,
        );
    }

    // Trả trạng thái model và candidate source; công thức cũ không còn cấu hình ở runtime.
    async getPolicy() {
        const candidateStatus = this.rules.getCandidateSourceStatus();
        const model = await this.mlRanking.getStatus();
        const runtime: RecommendationPolicyRuntimeStatus = {
            rankingMode: 'AI_MODEL',
            objective: 'lambdarank',
            candidateSources: candidateStatus,
            model,
        };
        return {
            version: this.rules.getRuleVersion(),
            rankingMode: 'AI_MODEL' as const,
            objective: 'lambdarank' as const,
            runtime,
        };
    }

    // Lịch sử policy chỉ trả metadata và config đã normalize để Admin có thể audit/rollback minh bạch.
    async getPolicyHistory() {
        const policies = await this.repository.findPolicyHistory(50);
        return policies.map((policy) => ({
            id: policy.id,
            version: policy.version,
            status: policy.status,
            config: policy.config,
            createdBy: policy.createdBy,
            reason: policy.reason,
            createdAt: policy.createdAt.toISOString(),
        }));
    }

    // Trả aggregate theo mode đã được attribution; mode legacy vẫn có thể xuất hiện ở event cũ.
    getRankingPerformance(from: Date, to: Date) {
        return this.repository.getRankingPerformance(from, to);
    }

}
