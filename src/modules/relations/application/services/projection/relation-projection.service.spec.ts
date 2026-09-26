import { RelationProjectionService } from '@/modules/relations/application/services/projection/relation-projection.service';

function interactionEvent(
    eventId: string,
    productId: string,
    occurredAt: string,
) {
    return {
        eventId,
        eventName: 'recommendation.interaction.recorded' as const,
        eventVersion: 1,
        source: 'web',
        aggregateId: productId,
        occurredAt,
        data: {
            interactionType: 'PRODUCT_VIEWED' as const,
            userId: null,
            sessionId: 'session-1',
            productId,
            variantId: null,
            categoryId: null,
            query: null,
            page: null,
            position: null,
            quantity: null,
            requestId: null,
        },
    };
}

describe('RelationProjectionService', () => {
    let target: RelationProjectionService;
    let mockRepository: {
        withProjection: jest.Mock;
        insertSignal: jest.Mock;
        findRecentSignals: jest.Mock;
        claimPair: jest.Mock;
        addRelations: jest.Mock;
        pruneSourceRelationsBatch: jest.Mock;
    };
    let mockRules: { getRelationWeight: jest.Mock };

    beforeEach(() => {
        // Arrange: mock toàn bộ persistence/rule dependency để chỉ kiểm tra pair-dedup policy.
        mockRepository = {
            withProjection: jest.fn(async (_eventId, _type, work) => work({})),
            insertSignal: jest.fn(),
            findRecentSignals: jest.fn(),
            claimPair: jest.fn(),
            addRelations: jest.fn(),
            pruneSourceRelationsBatch: jest.fn(),
        };
        mockRules = { getRelationWeight: jest.fn().mockReturnValue(1) };
        target = new RelationProjectionService(
            mockRepository as never,
            mockRules as never,
        );
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('should count an out-of-order pair once when pair ledger accepts it', async () => {
        // Arrange: event mới đến trước nên chưa thể tạo pair; event cũ đến sau sẽ nhìn thấy cả hai signal.
        const newer = interactionEvent(
            'event-newer',
            'product-newer',
            '2026-09-11T10:05:00.000Z',
        );
        const older = interactionEvent(
            'event-older',
            'product-older',
            '2026-09-11T10:00:00.000Z',
        );
        mockRepository.findRecentSignals
            .mockResolvedValueOnce([
                {
                    eventId: newer.eventId,
                    productId: newer.data.productId,
                    occurredAt: new Date(newer.occurredAt),
                },
            ])
            .mockResolvedValueOnce([
                {
                    eventId: older.eventId,
                    productId: older.data.productId,
                    occurredAt: new Date(older.occurredAt),
                },
                {
                    eventId: newer.eventId,
                    productId: newer.data.productId,
                    occurredAt: new Date(newer.occurredAt),
                },
            ]);
        mockRepository.claimPair.mockResolvedValue(true);

        // Act: xử lý event sai thứ tự.
        await target.projectInteraction(newer);
        await target.projectInteraction(older);

        // Assert: pair chỉ được ghi một lần, theo cả hai hướng.
        expect(mockRepository.claimPair).toHaveBeenCalledTimes(1);
        expect(mockRepository.addRelations).toHaveBeenCalledTimes(1);
        expect(mockRepository.addRelations.mock.calls[0][0]).toHaveLength(2);
    });

    it('should not add relation when pair ledger rejects an already claimed pair', async () => {
        // Arrange: signal hiện tại và signal liên quan đã được pair-ledger claim trước đó.
        const current = interactionEvent(
            'event-current',
            'product-current',
            '2026-09-11T10:05:00.000Z',
        );
        mockRepository.findRecentSignals.mockResolvedValue([
            {
                eventId: current.eventId,
                productId: current.data.productId,
                occurredAt: new Date(current.occurredAt),
            },
            {
                eventId: 'event-already-claimed',
                productId: 'product-related',
                occurredAt: new Date('2026-09-11T10:00:00.000Z'),
            },
        ]);
        mockRepository.claimPair.mockResolvedValue(false);

        // Act: projector nhận một pair đã tồn tại trong ledger.
        await target.projectInteraction(current);

        // Assert: không cộng score lần hai và vẫn prune được source theo policy.
        expect(mockRepository.claimPair).toHaveBeenCalledTimes(1);
        expect(mockRepository.addRelations).not.toHaveBeenCalled();
        expect(mockRepository.pruneSourceRelationsBatch).toHaveBeenCalledTimes(
            1,
        );
    });
});
