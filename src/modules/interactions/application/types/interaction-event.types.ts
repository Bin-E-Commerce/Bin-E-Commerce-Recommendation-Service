// File này là boundary type nội bộ cho interaction, tái sử dụng contract chung mà không kéo alias runtime vào dist.

import type {
    RecommendationInteractionRecordedEvent,
    RecommendationInteractionType,
} from '@common/kafka/events/recommendation.events';

export type {
    RecommendationInteractionRecordedEvent,
    RecommendationInteractionType,
};
