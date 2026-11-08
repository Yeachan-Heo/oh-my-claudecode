import { describe, it, expect, vi, beforeEach } from 'vitest';
// Mock dispatch-queue module
vi.mock('../team/dispatch-queue.js', () => ({
    enqueueDispatchRequest: vi.fn(),
    readDispatchRequest: vi.fn(),
    transitionDispatchRequest: vi.fn(),
    markDispatchRequestNotified: vi.fn(),
}));
vi.mock('../lib/swallowed-error.js', () => ({
    createSwallowedErrorLogger: () => () => { },
}));
import { queueInboxInstruction } from '../team/mcp-comm.js';
import { enqueueDispatchRequest, markDispatchRequestNotified, readDispatchRequest, transitionDispatchRequest, } from '../team/dispatch-queue.js';
const mockedEnqueue = vi.mocked(enqueueDispatchRequest);
const mockedMarkNotified = vi.mocked(markDispatchRequestNotified);
const mockedReadDispatch = vi.mocked(readDispatchRequest);
const mockedTransition = vi.mocked(transitionDispatchRequest);
function makeRequest(overrides = {}) {
    return {
        request_id: 'req-001',
        kind: 'inbox',
        team_name: 'test-team',
        to_worker: 'worker-1',
        worker_index: 0,
        trigger_message: 'new task',
        transport_preference: 'hook_preferred_with_fallback',
        fallback_allowed: true,
        status: 'pending',
        attempt_count: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...overrides,
    };
}
describe('queueInboxInstruction dedup ordering', () => {
    const writeWorkerInbox = vi.fn();
    const notify = vi.fn();
    beforeEach(() => {
        vi.clearAllMocks();
        writeWorkerInbox.mockResolvedValue(undefined);
        notify.mockReturnValue({
            ok: true,
            transport: 'hook',
            reason: 'dispatched',
        });
    });
    function makeParams(overrides = {}) {
        return {
            teamName: 'test-team',
            workerName: 'worker-1',
            workerIndex: 0,
            inbox: 'task content',
            triggerMessage: 'new task',
            cwd: '/tmp/test',
            notify,
            deps: { writeWorkerInbox },
            ...overrides,
        };
    }
    it('should call enqueueDispatchRequest before writeWorkerInbox', async () => {
        const callOrder = [];
        writeWorkerInbox.mockImplementation(async () => {
            callOrder.push('writeWorkerInbox');
        });
        mockedEnqueue.mockImplementation(async () => {
            callOrder.push('enqueueDispatchRequest');
            return { request: makeRequest(), deduped: false };
        });
        mockedMarkNotified.mockResolvedValue(undefined);
        await queueInboxInstruction(makeParams());
        expect(callOrder).toEqual(['enqueueDispatchRequest', 'writeWorkerInbox']);
    });
    it('should NOT call writeWorkerInbox when dedup rejects', async () => {
        mockedEnqueue.mockResolvedValue({
            request: makeRequest(),
            deduped: true,
        });
        const result = await queueInboxInstruction(makeParams());
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('duplicate_pending_dispatch_request');
        expect(writeWorkerInbox).not.toHaveBeenCalled();
    });
    it('should call markImmediateDispatchFailure and re-throw on writeWorkerInbox failure', async () => {
        const inboxError = new Error('disk full');
        writeWorkerInbox.mockRejectedValue(inboxError);
        const request = makeRequest();
        mockedEnqueue.mockResolvedValue({ request, deduped: false });
        mockedReadDispatch.mockResolvedValue({ ...request, status: 'pending' });
        mockedTransition.mockResolvedValue(undefined);
        await expect(queueInboxInstruction(makeParams())).rejects.toThrow('disk full');
    });
    it('should mark dispatch as failed with inbox_write_failed reason on write error', async () => {
        const inboxError = new Error('disk full');
        writeWorkerInbox.mockRejectedValue(inboxError);
        const request = makeRequest({ transport_preference: 'transport_direct' });
        mockedEnqueue.mockResolvedValue({ request, deduped: false });
        mockedReadDispatch.mockResolvedValue({ ...request, status: 'pending' });
        mockedTransition.mockResolvedValue(undefined);
        await expect(queueInboxInstruction(makeParams({ transportPreference: 'transport_direct' }))).rejects.toThrow('disk full');
        // markImmediateDispatchFailure reads the request and transitions it to failed
        expect(mockedReadDispatch).toHaveBeenCalledWith('test-team', 'req-001', '/tmp/test');
        expect(mockedTransition).toHaveBeenCalledWith('test-team', 'req-001', 'pending', 'failed', expect.objectContaining({ last_reason: 'inbox_write_failed' }), '/tmp/test');
    });
});
//# sourceMappingURL=mcp-comm-inbox-dedup.test.js.map