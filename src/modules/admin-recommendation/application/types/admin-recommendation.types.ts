// Contract cho Admin Recommendation Center; các type này chỉ mô tả dữ liệu đã aggregate và không lộ PII nhạy cảm.

export interface RecommendationAnalyticsQuery {
  from: Date;
  to: Date;
}

export interface RecommendationActorQuery extends RecommendationAnalyticsQuery {
  page: number;
  pageSize: number;
  actorType?: "USER" | "SESSION";
  search?: string;
  actorIds?: string[];
}

export interface RecommendationPolicyConfig {
  hybridWeights: Record<string, number>;
  mlEnabled: boolean;
  mlBlend: number;
}

export interface RecommendationPolicyRuntimeStatus {
  standardEnabled: true;
  aiPolicyEnabled: boolean;
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
    fallback: boolean;
    modelVersion: string | null;
    featureCount: number | null;
  };
}
