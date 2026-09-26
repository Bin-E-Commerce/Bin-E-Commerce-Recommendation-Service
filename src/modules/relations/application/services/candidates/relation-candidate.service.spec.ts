// Unit test cho cờ bật co-behavior, giới hạn anchor và fallback khi relation store lỗi.
/// <reference types="jest" />

import { createMock, type DeepMocked } from '@golevelup/ts-jest';
import { RelationRepository } from '@/modules/relations/infrastructure/repositories/relation.repository';
import { RecommendationRuleService } from '@/modules/profiles/application/services/rules/recommendation-rule.service';
import { RelationCandidateService } from '@/modules/relations/application/services/candidates/relation-candidate.service';

describe('RelationCandidateService', () => {
    let target: RelationCandidateService;
    let mockRepository: DeepMocked<RelationRepository>;
    let mockRules: DeepMocked<RecommendationRuleService>;

    beforeEach(() => {
        mockRepository = createMock<RelationRepository>();
        mockRules = createMock<RecommendationRuleService>();
        mockRules.isCandidateSourceEnabled.mockReturnValue(true);
        target = new RelationCandidateService(mockRepository, mockRules);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('should query related products when both candidate flags are enabled', async () => {
        // Arrange
        mockRepository.findTargets.mockResolvedValue([
            {
                productId: 'product-related',
                rawScore: 2,
                anchorProductId: 'anchor-1',
                relationType: 'CO_VIEW',
            },
            {
                productId: 'product-excluded',
                rawScore: 1,
                anchorProductId: 'anchor-1',
                relationType: 'CO_CART',
            },
        ]);
        const anchors = Array.from(
            { length: 12 },
            (_, index) => `anchor-${index}`,
        );

        // Act
        const result = await target.findCandidates(
            [...anchors, 'anchor-0'],
            ['product-excluded'],
            120,
        );

        // Assert
        expect(result).toEqual([
            {
                productId: 'product-related',
                rawScore: 2,
                anchorProductId: 'anchor-1',
                relationType: 'CO_VIEW',
            },
        ]);
        expect(mockRepository.findTargets).toHaveBeenCalledWith(
            anchors.slice(0, 10),
            ['CO_PURCHASE', 'CO_CART', 'CO_VIEW'],
            100,
        );
    });

    it('should skip the relation query when a candidate flag is disabled', async () => {
        // Arrange
        mockRules.isCandidateSourceEnabled.mockReturnValue(false);

        // Act
        const result = await target.findCandidates(['anchor-1'], [], 10);

        // Assert
        expect(result).toEqual([]);
        expect(mockRepository.findTargets).not.toHaveBeenCalled();
    });

    it('should return no related candidates when the relation repository fails', async () => {
        // Arrange
        mockRepository.findTargets.mockRejectedValue(
            new Error('database unavailable'),
        );

        // Act
        const result = await target.findCandidates(['anchor-1'], [], 10);

        // Assert
        expect(result).toEqual([]);
        expect(mockRepository.findTargets).toHaveBeenCalledTimes(1);
    });
});
