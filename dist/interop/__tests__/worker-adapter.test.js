import { describe, expect, it } from 'vitest';
import { omxStatusToOmc, omcStatusToOmx, teamConfigToOmx, omxConfigToTeam, omxTaskToTaskFile, taskFileToOmxTask, mapOmxRoleToCliAgent, outboxMessageToOmxMailbox, omxMailboxToInboxMarkdown, isOmxWorker, } from '../worker-adapter.js';
// ============================================================================
// Status Mapping
// ============================================================================
describe('omxStatusToOmc', () => {
    it('maps pending directly (non-lossy)', () => {
        const result = omxStatusToOmc('pending');
        expect(result.status).toBe('pending');
        expect(result.annotation.lossy).toBe(false);
        expect(result.annotation.originalSystem).toBe('omx');
    });
    it('maps in_progress directly (non-lossy)', () => {
        const result = omxStatusToOmc('in_progress');
        expect(result.status).toBe('in_progress');
        expect(result.annotation.lossy).toBe(false);
    });
    it('maps completed directly (non-lossy)', () => {
        const result = omxStatusToOmc('completed');
        expect(result.status).toBe('completed');
        expect(result.annotation.lossy).toBe(false);
    });
    it('maps failed directly (non-lossy, enabled by Phase 0)', () => {
        const result = omxStatusToOmc('failed');
        expect(result.status).toBe('failed');
        expect(result.annotation.lossy).toBe(false);
        expect(result.annotation.originalStatus).toBe('failed');
    });
    it('maps blocked to pending (lossy)', () => {
        const result = omxStatusToOmc('blocked');
        expect(result.status).toBe('pending');
        expect(result.annotation.lossy).toBe(true);
        expect(result.annotation.originalStatus).toBe('blocked');
        expect(result.annotation.originalSystem).toBe('omx');
    });
    it('includes ISO timestamp in annotation', () => {
        const result = omxStatusToOmc('pending');
        expect(result.annotation.mappedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
});
describe('omcStatusToOmx', () => {
    it('maps pending directly', () => {
        expect(omcStatusToOmx('pending')).toBe('pending');
    });
    it('maps in_progress directly', () => {
        expect(omcStatusToOmx('in_progress')).toBe('in_progress');
    });
    it('maps completed directly', () => {
        expect(omcStatusToOmx('completed')).toBe('completed');
    });
    it('maps failed directly', () => {
        expect(omcStatusToOmx('failed')).toBe('failed');
    });
    it('recovers blocked from lossy metadata annotation (round-trip)', () => {
        // Simulate: OMX blocked → OMC pending (with annotation) → OMX blocked
        const { status, annotation } = omxStatusToOmc('blocked');
        expect(status).toBe('pending');
        const recovered = omcStatusToOmx(status, { _interop: annotation });
        expect(recovered).toBe('blocked');
    });
    it('does not recover when metadata has non-lossy annotation', () => {
        const annotation = {
            originalSystem: 'omx',
            originalStatus: 'completed',
            mappedStatus: 'completed',
            mappedAt: new Date().toISOString(),
            lossy: false,
        };
        // Should not override — annotation is non-lossy
        const result = omcStatusToOmx('completed', { _interop: annotation });
        expect(result).toBe('completed');
    });
    it('handles missing metadata gracefully', () => {
        expect(omcStatusToOmx('pending', undefined)).toBe('pending');
        expect(omcStatusToOmx('failed', {})).toBe('failed');
    });
});
describe('round-trip status mapping', () => {
    it('blocked survives round-trip via metadata', () => {
        const step1 = omxStatusToOmc('blocked');
        const step2 = omcStatusToOmx(step1.status, { _interop: step1.annotation });
        expect(step2).toBe('blocked');
    });
    it('failed maps directly both ways (no metadata needed)', () => {
        const step1 = omxStatusToOmc('failed');
        expect(step1.status).toBe('failed');
        expect(step1.annotation.lossy).toBe(false);
        const step2 = omcStatusToOmx('failed');
        expect(step2).toBe('failed');
    });
    for (const status of ['pending', 'in_progress', 'completed', 'failed']) {
        it(`OMC ${status} → OMX → OMC round-trips losslessly`, () => {
            const omxStatus = omcStatusToOmx(status);
            const { status: omcStatus } = omxStatusToOmc(omxStatus);
            expect(omcStatus).toBe(status);
        });
    }
});
// ============================================================================
// Config Translation
// ============================================================================
describe('mapOmxRoleToCliAgent', () => {
    it('maps codex to codex', () => {
        expect(mapOmxRoleToCliAgent('codex')).toBe('codex');
    });
    it('maps gemini to gemini', () => {
        expect(mapOmxRoleToCliAgent('gemini')).toBe('gemini');
    });
    it('maps executor/coder/developer to claude', () => {
        expect(mapOmxRoleToCliAgent('executor')).toBe('claude');
        expect(mapOmxRoleToCliAgent('coder')).toBe('claude');
        expect(mapOmxRoleToCliAgent('developer')).toBe('claude');
    });
    it('defaults unknown roles to claude', () => {
        expect(mapOmxRoleToCliAgent('unknown')).toBe('claude');
        expect(mapOmxRoleToCliAgent('')).toBe('claude');
    });
    it('is case-insensitive', () => {
        expect(mapOmxRoleToCliAgent('CODEX')).toBe('codex');
        expect(mapOmxRoleToCliAgent('Gemini')).toBe('gemini');
    });
});
describe('teamConfigToOmx', () => {
    const omcConfig = {
        teamName: 'test-team',
        workerCount: 2,
        agentTypes: ['claude', 'codex'],
        tasks: [
            { subject: 'Fix auth', description: 'Fix the auth module' },
            { subject: 'Add tests', description: 'Add unit tests' },
        ],
        cwd: '/tmp/test',
    };
    it('translates team name', () => {
        const result = teamConfigToOmx(omcConfig);
        expect(result.name).toBe('test-team');
    });
    it('joins task subjects for the task field', () => {
        const result = teamConfigToOmx(omcConfig);
        expect(result.task).toBe('Fix auth; Add tests');
    });
    it('maps worker count correctly', () => {
        const result = teamConfigToOmx(omcConfig);
        expect(result.worker_count).toBe(2);
        expect(result.max_workers).toBe(2);
    });
    it('creates worker entries with correct roles', () => {
        const result = teamConfigToOmx(omcConfig);
        expect(result.workers).toHaveLength(2);
        expect(result.workers[0].name).toBe('worker-1');
        expect(result.workers[0].role).toBe('claude');
        expect(result.workers[1].role).toBe('codex');
    });
    it('sets next_task_id based on task count', () => {
        const result = teamConfigToOmx(omcConfig);
        expect(result.next_task_id).toBe(3);
    });
    it('includes ISO timestamp for created_at', () => {
        const result = teamConfigToOmx(omcConfig);
        expect(result.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
});
describe('omxConfigToTeam', () => {
    const omxConfig = {
        name: 'omx-team',
        task: 'Fix all bugs',
        agent_type: 'executor',
        worker_count: 3,
        max_workers: 5,
        workers: [
            { name: 'w1', index: 0, role: 'executor', assigned_tasks: [] },
            { name: 'w2', index: 1, role: 'codex', assigned_tasks: [] },
            { name: 'w3', index: 2, role: 'gemini', assigned_tasks: [] },
        ],
        created_at: '2026-02-27T00:00:00Z',
        tmux_session: 'omx-session',
        next_task_id: 4,
    };
    const tasks = [
        {
            id: '1', subject: 'Task 1', description: 'Desc 1',
            status: 'pending', created_at: '2026-02-27T00:00:00Z',
        },
    ];
    it('translates team name and worker count', () => {
        const result = omxConfigToTeam(omxConfig, tasks, '/tmp/test');
        expect(result.teamName).toBe('omx-team');
        expect(result.workerCount).toBe(3);
    });
    it('maps worker roles to CliAgentType', () => {
        const result = omxConfigToTeam(omxConfig, tasks, '/tmp/test');
        expect(result.agentTypes).toEqual(['claude', 'codex', 'gemini']);
    });
    it('translates tasks', () => {
        const result = omxConfigToTeam(omxConfig, tasks, '/tmp/test');
        expect(result.tasks).toHaveLength(1);
        expect(result.tasks[0].subject).toBe('Task 1');
    });
    it('uses provided cwd', () => {
        const result = omxConfigToTeam(omxConfig, tasks, '/custom/path');
        expect(result.cwd).toBe('/custom/path');
    });
});
// ============================================================================
// Task Translation
// ============================================================================
describe('omxTaskToTaskFile', () => {
    it('translates basic task fields', () => {
        const omxTask = {
            id: '42', subject: 'Fix bug', description: 'Fix the login bug',
            status: 'in_progress', owner: 'worker-1',
            created_at: '2026-02-27T00:00:00Z',
        };
        const result = omxTaskToTaskFile(omxTask);
        expect(result.id).toBe('42');
        expect(result.subject).toBe('Fix bug');
        expect(result.description).toBe('Fix the login bug');
        expect(result.status).toBe('in_progress');
        expect(result.owner).toBe('worker-1');
    });
    it('maps blocked to pending with annotation', () => {
        const omxTask = {
            id: '1', subject: 'S', description: 'D',
            status: 'blocked', blocked_by: ['2'],
            created_at: '2026-02-27T00:00:00Z',
        };
        const result = omxTaskToTaskFile(omxTask);
        expect(result.status).toBe('pending');
        expect(result.blockedBy).toEqual(['2']);
        const annotation = result.metadata?._interop;
        expect(annotation.lossy).toBe(true);
        expect(annotation.originalStatus).toBe('blocked');
    });
    it('maps failed directly', () => {
        const omxTask = {
            id: '1', subject: 'S', description: 'D',
            status: 'failed', error: 'Timeout',
            created_at: '2026-02-27T00:00:00Z',
        };
        const result = omxTaskToTaskFile(omxTask);
        expect(result.status).toBe('failed');
        expect(result.metadata?._interopError).toBe('Timeout');
    });
    it('preserves error and result in metadata', () => {
        const omxTask = {
            id: '1', subject: 'S', description: 'D',
            status: 'completed', result: 'All tests pass', error: undefined,
            created_at: '2026-02-27T00:00:00Z',
        };
        const result = omxTaskToTaskFile(omxTask);
        expect(result.metadata?._interopResult).toBe('All tests pass');
        expect(result.metadata?._interopError).toBeUndefined();
    });
    it('maps depends_on to blockedBy when blocked_by is absent', () => {
        const omxTask = {
            id: '1', subject: 'S', description: 'D',
            status: 'pending', depends_on: ['3', '4'],
            created_at: '2026-02-27T00:00:00Z',
        };
        const result = omxTaskToTaskFile(omxTask);
        expect(result.blockedBy).toEqual(['3', '4']);
    });
    it('defaults owner to empty string when absent', () => {
        const omxTask = {
            id: '1', subject: 'S', description: 'D',
            status: 'pending', created_at: '2026-02-27T00:00:00Z',
        };
        const result = omxTaskToTaskFile(omxTask);
        expect(result.owner).toBe('');
    });
});
describe('taskFileToOmxTask', () => {
    it('translates basic fields', () => {
        const taskFile = {
            id: '10', subject: 'Refactor', description: 'Refactor auth',
            status: 'completed', owner: 'worker-2',
            blocks: [], blockedBy: [],
        };
        const result = taskFileToOmxTask(taskFile);
        expect(result.id).toBe('10');
        expect(result.subject).toBe('Refactor');
        expect(result.status).toBe('completed');
        expect(result.owner).toBe('worker-2');
    });
    it('maps failed directly', () => {
        const taskFile = {
            id: '1', subject: 'S', description: 'D',
            status: 'failed', owner: '',
            blocks: [], blockedBy: [],
        };
        const result = taskFileToOmxTask(taskFile);
        expect(result.status).toBe('failed');
    });
    it('recovers blocked from lossy metadata annotation', () => {
        const annotation = {
            originalSystem: 'omx',
            originalStatus: 'blocked',
            mappedStatus: 'pending',
            mappedAt: new Date().toISOString(),
            lossy: true,
        };
        const taskFile = {
            id: '1', subject: 'S', description: 'D',
            status: 'pending', owner: '', blocks: [], blockedBy: ['2'],
            metadata: { _interop: annotation },
        };
        const result = taskFileToOmxTask(taskFile);
        expect(result.status).toBe('blocked');
    });
    it('preserves blockedBy as both blocked_by and depends_on', () => {
        const taskFile = {
            id: '1', subject: 'S', description: 'D',
            status: 'pending', owner: '', blocks: [], blockedBy: ['5', '6'],
        };
        const result = taskFileToOmxTask(taskFile);
        expect(result.blocked_by).toEqual(['5', '6']);
        expect(result.depends_on).toEqual(['5', '6']);
    });
    it('preserves error and result from metadata', () => {
        const taskFile = {
            id: '1', subject: 'S', description: 'D',
            status: 'failed', owner: '', blocks: [], blockedBy: [],
            metadata: { _interopError: 'Crash', _interopResult: 'partial' },
        };
        const result = taskFileToOmxTask(taskFile);
        expect(result.error).toBe('Crash');
        expect(result.result).toBe('partial');
    });
    it('omits owner when empty string', () => {
        const taskFile = {
            id: '1', subject: 'S', description: 'D',
            status: 'pending', owner: '', blocks: [], blockedBy: [],
        };
        const result = taskFileToOmxTask(taskFile);
        expect(result.owner).toBeUndefined();
    });
});
// ============================================================================
// Message Format Bridging
// ============================================================================
describe('outboxMessageToOmxMailbox', () => {
    it('translates outbox message to OMX mailbox format', () => {
        const msg = {
            type: 'task_complete',
            taskId: '1',
            summary: 'Task completed successfully',
            message: 'All tests pass',
            timestamp: '2026-02-27T12:00:00Z',
        };
        const result = outboxMessageToOmxMailbox(msg, 'worker-1', 'omc-lead');
        expect(result.from_worker).toBe('worker-1');
        expect(result.to_worker).toBe('omc-lead');
        expect(result.body).toBe('All tests pass');
        expect(result.created_at).toBe('2026-02-27T12:00:00Z');
        expect(result.message_id).toMatch(/^[0-9a-f-]{36}$/);
    });
    it('falls back to summary when message is absent', () => {
        const msg = {
            type: 'idle',
            summary: 'Worker idle',
            timestamp: '2026-02-27T12:00:00Z',
        };
        const result = outboxMessageToOmxMailbox(msg, 'w1', 'w2');
        expect(result.body).toBe('Worker idle');
    });
    it('falls back to JSON when both message and summary are absent', () => {
        const msg = {
            type: 'heartbeat',
            timestamp: '2026-02-27T12:00:00Z',
        };
        const result = outboxMessageToOmxMailbox(msg, 'w1', 'w2');
        expect(result.body).toContain('heartbeat');
    });
    it('produces unique message IDs', () => {
        const msg = { type: 'idle', timestamp: '2026-02-27T12:00:00Z' };
        const r1 = outboxMessageToOmxMailbox(msg, 'w1', 'w2');
        const r2 = outboxMessageToOmxMailbox(msg, 'w1', 'w2');
        expect(r1.message_id).not.toBe(r2.message_id);
    });
});
describe('omxMailboxToInboxMarkdown', () => {
    it('produces markdown with sender and timestamp', () => {
        const msg = {
            message_id: 'abc-123',
            from_worker: 'omx-worker-1',
            to_worker: 'omc-lead',
            body: 'Task completed.\nAll tests pass.',
            created_at: '2026-02-27T12:00:00Z',
        };
        const result = omxMailboxToInboxMarkdown(msg);
        expect(result).toContain('---');
        expect(result).toContain('## Message from omx-worker-1');
        expect(result).toContain('*2026-02-27T12:00:00Z*');
        expect(result).toContain('Task completed.\nAll tests pass.');
    });
});
// ============================================================================
// Utility
// ============================================================================
describe('isOmxWorker', () => {
    it('returns true for omx interopMode', () => {
        expect(isOmxWorker({ workerName: 'w1', agentType: 'claude', interopMode: 'omx' })).toBe(true);
    });
    it('returns false for omc interopMode', () => {
        expect(isOmxWorker({ workerName: 'w1', agentType: 'claude', interopMode: 'omc' })).toBe(false);
    });
});
//# sourceMappingURL=worker-adapter.test.js.map