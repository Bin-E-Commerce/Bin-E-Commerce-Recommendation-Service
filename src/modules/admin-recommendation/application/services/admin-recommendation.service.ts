// Application service cho Admin Recommendation Center; kiểm tra input, quyền nghiệp vụ policy và gọi repository read/write.

import {
    BadRequestException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RecommendationRuleService } from '@/modules/profiles/application/services/rules/recommendation-rule.service';
import { RecommendationAdminRepository } from '@/modules/admin-recommendation/infrastructure/repositories/recommendation-admin.repository';
import type {
    RecommendationAnalyticsQuery,
    RecommendationActorQuery,
    RecommendationPolicyConfig,
    RecommendationPolicyRuntimeStatus,
} from '@/modules/admin-recommendation/application/types/admin-recommendation.types';
import { RecommendationAccountDirectoryClient } from '@/modules/admin-recommendation/infrastructure/clients/recommendation-account-directory.client';
import { RecommendationMlRankingService } from '@/modules/recommendation/application/services/ranking/ml/recommendation-ml-ranking.service';

const STANDARD_WEIGHT_KEYS = [
    'profileAffinity',
    'sessionContext',
    'semanticSimilarity',
    'coBehavior',
    'popularity',
    'freshness',
    'quality',
    'exploration',
] as const;

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

    // Trả policy đang chạy; nếu chưa có DB record thì phản ánh env/default runtime hiện tại.
    async getPolicy() {
        const active = await this.repository.findActivePolicy();
        const defaults = this.rules.getPolicySnapshot();
        const stored = (active?.config ??
            {}) as Partial<RecommendationPolicyConfig>;
        const config: RecommendationPolicyConfig = {
            hybridWeights: {
                ...defaults.hybridWeights,
                ...(stored.hybridWeights ?? {}),
            },
            mlEnabled: stored.mlEnabled ?? defaults.mlEnabled,
            mlBlend: stored.mlBlend ?? defaults.mlBlend,
        };
        const candidateStatus = this.rules.getCandidateSourceStatus();
        const model = await this.mlRanking.getStatus();
        const runtime: RecommendationPolicyRuntimeStatus = {
            standardEnabled: true,
            aiPolicyEnabled: config.mlEnabled,
            candidateSources: candidateStatus,
            model,
        };
        return {
            version: active?.version ?? defaults.version,
            status: active?.status ?? 'RUNTIME_DEFAULT',
            config,
            runtime,
            createdBy: active?.createdBy ?? null,
            reason: active?.reason ?? null,
            createdAt: active?.createdAt?.toISOString() ?? null,
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

    // Validate và activate policy mới trong transaction-level sequence; runtime rule đổi ngay sau khi DB save thành công.
    async updatePolicy(
        input: {
            hybridWeights?: Record<string, unknown>;
            reason?: string;
            mlEnabled?: boolean;
            mlBlend?: number;
        },
        actorUserId: string,
    ) {
        // Đọc active policy từ DB trước khi merge PATCH để instance đang chậm polling không ghi đè thay đổi mới của instance khác.
        const defaults = this.rules.getPolicySnapshot();
        const active = await this.repository.findActivePolicy();
        const stored = (active?.config ??
            {}) as Partial<RecommendationPolicyConfig>;
        const current: RecommendationPolicyConfig = {
            hybridWeights: {
                ...defaults.hybridWeights,
                ...(stored.hybridWeights ?? {}),
            },
            mlEnabled: stored.mlEnabled ?? defaults.mlEnabled,
            mlBlend: stored.mlBlend ?? defaults.mlBlend,
        };
        const config = this.normalizeConfig({
            // PATCH policy phải giữ lại các weight không được gửi lên; nếu thay cả object bằng payload một phần,
            // normalizeWeights sẽ coi field thiếu là 0 và vô tình làm mất trọng số đang chạy.
            hybridWeights: {
                ...current.hybridWeights,
                ...(input.hybridWeights ?? {}),
            },
            mlEnabled: input.mlEnabled ?? current.mlEnabled,
            mlBlend: input.mlBlend ?? current.mlBlend,
        });
        const version = `admin-${Date.now()}-${randomUUID().slice(0, 8)}`;
        const saved = await this.repository.activatePolicy({
            version,
            status: 'ACTIVE',
            config: config as unknown as Record<string, unknown>,
            createdBy: actorUserId,
            reason: input.reason?.trim() || null,
        });
        this.rules.setRuntimePolicy({
            version,
            hybridWeights: config.hybridWeights,
            mlEnabled: config.mlEnabled,
            mlBlend: config.mlBlend,
        });
        return {
            version: saved.version,
            status: saved.status,
            config: saved.config,
            createdBy: saved.createdBy,
            reason: saved.reason,
            createdAt: saved.createdAt.toISOString(),
        };
    }

    // Rollback dùng bản policy immutable đã lưu; chỉ đổi active pointer và áp dụng lại cùng runtime version.
    async rollbackPolicy(version: string, actorUserId: string) {
        const history = await this.repository.findPolicyHistory(100);
        const target = history.find((policy) => policy.version === version);
        if (!target) throw new NotFoundException('Policy version not found');
        const defaults = this.rules.getPolicySnapshot();
        const stored = target.config as Partial<RecommendationPolicyConfig>;
        const config = this.normalizeConfig({
            hybridWeights: {
                ...(stored.hybridWeights ?? defaults.hybridWeights),
            },
            mlEnabled: stored.mlEnabled ?? defaults.mlEnabled,
            mlBlend: stored.mlBlend ?? defaults.mlBlend,
        });
        const rollbackVersion = `rollback-${Date.now()}-${randomUUID().slice(0, 8)}`;
        const saved = await this.repository.activatePolicy({
            version: rollbackVersion,
            status: 'ACTIVE',
            config: config as unknown as Record<string, unknown>,
            createdBy: actorUserId,
            reason: `Rollback về ${version}`,
        });
        this.rules.setRuntimePolicy({
            version: rollbackVersion,
            hybridWeights: config.hybridWeights,
            mlEnabled: config.mlEnabled,
            mlBlend: config.mlBlend,
        });
        return {
            version: saved.version,
            rolledBackFrom: version,
            config: saved.config,
            createdAt: saved.createdAt.toISOString(),
        };
    }

    // Trả aggregate theo ranking mode thực tế để Admin đo AI và Standard/fallback trên toàn bộ traffic.
    getRankingPerformance(from: Date, to: Date) {
        return this.repository.getRankingPerformance(from, to);
    }

    // Normalize weight tại một boundary duy nhất và chặn key lạ để config không âm thầm bị bỏ qua.
    private normalizeConfig(input: {
        hybridWeights: Record<string, unknown>;
        mlEnabled?: boolean;
        mlBlend?: number;
    }): RecommendationPolicyConfig {
        const hybridWeights = this.normalizeWeights(
            input.hybridWeights,
            STANDARD_WEIGHT_KEYS,
        );
        const mlEnabled = Boolean(input.mlEnabled ?? false);
        return {
            hybridWeights,
            mlEnabled,
            mlBlend: this.normalizeMlBlend(input.mlBlend ?? 0.3),
        };
    }

    // Giới hạn ảnh hưởng ML tại backend; admin không thể gửi blend âm, NaN hoặc vượt 50%.
    private normalizeMlBlend(value: number): number {
        if (!Number.isFinite(value) || value < 0 || value > 0.5) {
            throw new BadRequestException('ML blend must be between 0 and 0.5');
        }
        return Number(value.toFixed(4));
    }

    // Mọi weight phải hữu hạn, không âm và có tổng dương; lưu normalized giúp trace và cache có semantics ổn định.
    private normalizeWeights(
        values: Record<string, unknown>,
        keys: readonly string[],
    ): Record<string, number> {
        const unknown = Object.keys(values).filter(
            (key) => !keys.includes(key),
        );
        if (unknown.length > 0) {
            throw new BadRequestException(
                `Unknown ranking weight: ${unknown[0]}`,
            );
        }
        const normalized = Object.fromEntries(
            keys.map((key) => {
                const value = Number(values[key] ?? 0);
                if (!Number.isFinite(value) || value < 0) {
                    throw new BadRequestException(
                        `Invalid ranking weight: ${key}`,
                    );
                }
                return [key, value];
            }),
        );
        const total = Object.values(normalized).reduce(
            (sum, value) => sum + value,
            0,
        );
        if (total <= 0)
            throw new BadRequestException(
                'Ranking weights must have a positive total',
            );
        return Object.fromEntries(
            Object.entries(normalized).map(([key, value]) => [
                key,
                Number((value / total).toFixed(8)),
            ]),
        );
    }
}
