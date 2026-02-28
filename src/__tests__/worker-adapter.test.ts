/**
 * Tests for OMC-OMX Worker Adapter (issue #1123)
 */

import { describe, it, expect } from 'vitest';
import {
  omxStatusToOmc,
  omcStatusToOmx,
  mapOmxRoleToCliAgent,
  omxTaskToTaskFile,
  taskFileToOmxTask,
  teamConfigToOmx,
  outboxMessageToOmxMailbox,
  omxMailboxToInboxMarkdown,
  isOmxWorker,
} from '../interop/worker-adapter.js';
import type { TaskFile } from '../team/types.js';
import type { OmxTeamTask } from '../interop/omx-team-state.js';

// ============================================================================
// Status Mapping
// ============================================================================

describe('omxStatusToOmc', () => {
  it.each([
    ['pending', 'pending', false],
    ['in_progress', 'in_progress', false],
    ['completed', 'completed', false],
    ['failed', 'failed', false],
  ] as const)('maps %s → %s (lossy: %s)', (omx, expectedOmc, lossy) => {
    const result = omxStatusToOmc(omx);
    expect(result.status).toBe(expectedOmc);
    expect(result.annotation.lossy).toBe(lossy);
    expect(result.annotation.originalSystem).toBe('omx');
  });

  it('maps blocked → pending with lossy annotation', () => {
    const result = omxStatusToOmc('blocked');
    expect(result.status).toBe('pending');
    expect(result.annotation.lossy).toBe(true);
    expect(result.annotation.originalStatus).toBe('blocked');
    expect(result.annotation.mappedStatus).toBe('pending');
  });
});

describe('omcStatusToOmx', () => {
  it.each([
    ['pending', 'pending'],
    ['in_progress', 'in_progress'],
    ['completed', 'completed'],
    ['failed', 'failed'],
  ] as const)('maps %s → %s without metadata', (omc, expectedOmx) => {
    const result = omcStatusToOmx(omc);
    expect(result).toBe(expectedOmx);
  });

  it('recovers blocked via round-trip metadata', () => {
    const metadata = {
      _interop: {
        originalSystem: 'omx' as const,
        originalStatus: 'blocked',
        mappedStatus: 'pending',
        mappedAt: new Date().toISOString(),
        lossy: true,
      },
    };
    const result = omcStatusToOmx('pending', metadata);
    expect(result).toBe('blocked');
  });

  it('does not recover when annotation is not lossy', () => {
    const metadata = {
      _interop: {
        originalSystem: 'omx' as const,
        originalStatus: 'pending',
        mappedStatus: 'pending',
        mappedAt: new Date().toISOString(),
        lossy: false,
      },
    };
    const result = omcStatusToOmx('pending', metadata);
    expect(result).toBe('pending');
  });
});

// ============================================================================
// Role Mapping
// ============================================================================

describe('mapOmxRoleToCliAgent', () => {
  it('maps codex → codex', () => expect(mapOmxRoleToCliAgent('codex')).toBe('codex'));
  it('maps Codex (uppercase) → codex', () => expect(mapOmxRoleToCliAgent('Codex')).toBe('codex'));
  it('maps gemini → gemini', () => expect(mapOmxRoleToCliAgent('gemini')).toBe('gemini'));
  it('maps executor → claude', () => expect(mapOmxRoleToCliAgent('executor')).toBe('claude'));
  it('maps coder → claude', () => expect(mapOmxRoleToCliAgent('coder')).toBe('claude'));
  it('maps unknown → claude', () => expect(mapOmxRoleToCliAgent('anything')).toBe('claude'));
});

// ============================================================================
// Task Translation
// ============================================================================

describe('omxTaskToTaskFile', () => {
  it('translates a completed OMX task', () => {
    const omxTask: OmxTeamTask = {
      id: 'T1',
      subject: 'Add login',
      description: 'Implement login page',
      status: 'completed',
      owner: 'worker-1',
      result: 'Login page added',
      created_at: '2026-01-01T00:00:00Z',
      completed_at: '2026-01-01T01:00:00Z',
    };

    const taskFile = omxTaskToTaskFile(omxTask);
    expect(taskFile.id).toBe('T1');
    expect(taskFile.subject).toBe('Add login');
    expect(taskFile.status).toBe('completed');
    expect(taskFile.owner).toBe('worker-1');
    expect(taskFile.metadata?._interopResult).toBe('Login page added');
  });

  it('translates a blocked OMX task with lossy annotation', () => {
    const omxTask: OmxTeamTask = {
      id: 'T2',
      subject: 'Deploy',
      description: 'Deploy to staging',
      status: 'blocked',
      blocked_by: ['T1'],
      created_at: '2026-01-01T00:00:00Z',
    };

    const taskFile = omxTaskToTaskFile(omxTask);
    expect(taskFile.status).toBe('pending');
    expect(taskFile.blockedBy).toEqual(['T1']);
    expect((taskFile.metadata?._interop as any)?.lossy).toBe(true);
  });
});

describe('taskFileToOmxTask', () => {
  it('translates OMC task to OMX format', () => {
    const taskFile: TaskFile = {
      id: 'T1',
      subject: 'Fix bug',
      description: 'Fix the login bug',
      status: 'in_progress',
      owner: 'w1',
      blocks: [],
      blockedBy: [],
    };

    const omxTask = taskFileToOmxTask(taskFile);
    expect(omxTask.id).toBe('T1');
    expect(omxTask.status).toBe('in_progress');
    expect(omxTask.subject).toBe('Fix bug');
  });

  it('round-trips blocked status via metadata', () => {
    // OMX blocked → OMC pending (with annotation) → back to OMX blocked
    const omxOriginal: OmxTeamTask = {
      id: 'T3',
      subject: 'Blocked task',
      description: 'Depends on T1',
      status: 'blocked',
      blocked_by: ['T1'],
      created_at: '2026-01-01T00:00:00Z',
    };

    const taskFile = omxTaskToTaskFile(omxOriginal);
    expect(taskFile.status).toBe('pending'); // lossy

    const roundTripped = taskFileToOmxTask(taskFile);
    expect(roundTripped.status).toBe('blocked'); // recovered!
  });
});

// ============================================================================
// Config Translation
// ============================================================================

describe('teamConfigToOmx', () => {
  it('translates TeamConfig to OmxTeamConfig', () => {
    const config = teamConfigToOmx({
      teamName: 'test-team',
      workerCount: 2,
      agentTypes: ['claude' as any, 'codex' as any],
      tasks: [
        { subject: 'Task 1', description: 'Do thing 1' },
        { subject: 'Task 2', description: 'Do thing 2' },
      ],
      cwd: '/tmp',
    });

    expect(config.name).toBe('test-team');
    expect(config.worker_count).toBe(2);
    expect(config.workers).toHaveLength(2);
    expect(config.next_task_id).toBe(3);
    expect(config.tmux_session).toContain('test-team');
  });
});

// ============================================================================
// Message Translation
// ============================================================================

describe('outboxMessageToOmxMailbox', () => {
  it('creates OMX mailbox message from OMC outbox', () => {
    const msg = {
      message: 'Task done!',
      summary: 'Completed task T1',
      timestamp: '2026-01-01T00:00:00Z',
    };

    const mailbox = outboxMessageToOmxMailbox(msg as any, 'worker-1', 'leader');
    expect(mailbox.from_worker).toBe('worker-1');
    expect(mailbox.to_worker).toBe('leader');
    expect(mailbox.body).toBe('Task done!');
    expect(mailbox.message_id).toBeTruthy();
  });
});

describe('omxMailboxToInboxMarkdown', () => {
  it('formats mailbox message as markdown', () => {
    const msg = {
      message_id: 'msg-1',
      from_worker: 'worker-1',
      to_worker: 'leader',
      body: 'Hello from worker',
      created_at: '2026-01-01T00:00:00Z',
    };

    const md = omxMailboxToInboxMarkdown(msg);
    expect(md).toContain('## Message from worker-1');
    expect(md).toContain('Hello from worker');
    expect(md).toContain('2026-01-01');
  });
});

// ============================================================================
// Utility
// ============================================================================

describe('isOmxWorker', () => {
  it('returns true for omx interop mode', () => {
    expect(isOmxWorker({ workerName: 'w1', agentType: 'claude', interopMode: 'omx' })).toBe(true);
  });

  it('returns false for omc interop mode', () => {
    expect(isOmxWorker({ workerName: 'w1', agentType: 'claude', interopMode: 'omc' })).toBe(false);
  });
});
