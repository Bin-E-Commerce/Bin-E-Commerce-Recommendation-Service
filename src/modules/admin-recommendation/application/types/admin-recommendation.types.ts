// Contract cho Admin Recommendation Center; các type này chỉ mô tả dữ liệu đã aggregate và không lộ PII nhạy cảm.

export interface RecommendationAnalyticsQuery {
    from: Date;
    to: Date;
}

export interface RecommendationActorQuery extends RecommendationAnalyticsQuery {
    page: number;
    pageSize: number;
    actorType?: 'USER' | 'SESSION';
    search?: string;
    actorIds?: string[];
}

export interface RecommendationPolicyRuntimeStatus {
    rankingMode: 'AI_MODEL';
    objective: 'lambdarank';
    candidateSources: {
        semanticEnabled: boolean;
        coBehaviorEnabled: boolean;
        semanticMasterEnabled: boolean;
        coBehaviorMasterEnabled: boolean;
        pipelineMasterEnabled: boolean;
    };
    model: {
        reachable: boolean;
        ready: boolean;
        modelVersion: string | null;
        featureCount: number | null;
    };
}
