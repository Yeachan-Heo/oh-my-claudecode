import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  initTeamState,
  listMailboxMessages,
} from '../state.js';
import { listDispatchRequests, readDispatchRequest } from '../dispatch-queue.js';
import type { TeamConfig } from '../types.js';
import {
  queueInboxInstruction,
  queueDirectMailboxMessage,
  queueBroadcastMailboxMessage,
} from '../mcp-comm.js';

const ORIGINAL_OMX_TEAM_STATE_ROOT = process.env.OMX_TEAM_STATE_ROOT;

beforeEach(() => {
  delete process.env.OMX_TEAM_STATE_ROOT;
});

afterEach(() => {
  if (typeof ORIGINAL_OMX_TEAM_STATE_ROOT === 'string') process.env.OMX_TEAM_STATE_ROOT = ORIGINAL_OMX_TEAM_STATE_ROOT;
  else delete process.env.OMX_TEAM_STATE_ROOT;
});

function teamConfig(name: string, workerCount: number): TeamConfig {
  return {
    name,
    task: 't',
    agent_type: 'executor',
    worker_launch_mode: 'prompt',
    worker_count: workerCount,
    max_workers: workerCount,
    created_at: '2026-01-01T00:00:00.000Z',
    tmux_session: 'test-session',
    next_task_id: 1,
    leader_pane_id: null,
    hud_pane_id: null,
    resize_hook_name: null,
    resize_hook_target: null,
    workers: Array.from({ length: workerCount }, (_, index) => ({
      name: `worker-${index + 1}`,
      index: index + 1,
      role: 'executor',
      worker_cli: 'codex',
      assigned_tasks: [],
    })),
  };
}

async function initTestTeam(name: string, workerCount: number, cwd: string): Promise<void> {
  await initTeamState(teamConfig(name, workerCount), cwd);
}

describe('mcp-comm', () => {
  it('queueInboxInstruction writes inbox before notifying', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omc-mcp-comm-'));
    try {
      await initTestTeam('alpha', 1, cwd);

      const events: string[] = [];
      const outcome = await queueInboxInstruction({
        teamName: 'alpha',
        workerName: 'worker-1',
        workerIndex: 1,
        inbox: '# hi',
        triggerMessage: 'trigger',
        intent: 'followup-relaunch',
        cwd,
        notify: async () => {
          events.push('notify');
          const inboxPath = join(cwd, '.omc', 'state', 'team', 'alpha', 'workers', 'worker-1', 'inbox.md');
          const content = await readFile(inboxPath, 'utf-8');
          assert.match(content, /# hi/);
          return { ok: true, transport: 'tmux_send_keys', reason: 'sent' };
        },
      });
      assert.equal(outcome.ok, true);
      assert.equal(outcome.transport, 'tmux_send_keys');
      assert.ok(outcome.request_id);
      assert.deepEqual(events, ['notify']);
      const requests = await listDispatchRequests('alpha', cwd, { kind: 'inbox' });
      assert.equal(requests[0]?.intent, 'followup-relaunch');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('queueDirectMailboxMessage writes message and marks notified only on successful notify', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omc-mcp-comm-'));
    try {
      await initTestTeam('alpha', 2, cwd);

      const outcome = await queueDirectMailboxMessage({
        teamName: 'alpha',
        fromWorker: 'worker-1',
        toWorker: 'worker-2',
        toWorkerIndex: 2,
        body: 'hello',
        triggerMessage: 'check mailbox',
        intent: 'pending-mailbox-review',
        cwd,
        notify: async () => ({ ok: true, transport: 'tmux_send_keys', reason: 'sent' }),
      });
      assert.equal(outcome.ok, true);
      assert.ok(outcome.request_id);
      assert.ok(outcome.message_id);

      const mailbox = await listMailboxMessages('alpha', 'worker-2', cwd);
      assert.equal(mailbox.length, 1);
      assert.equal(mailbox[0]?.body, 'hello');
      assert.ok(mailbox[0]?.notified_at);
      const requests = await listDispatchRequests('alpha', cwd, { kind: 'mailbox' });
      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.message_id, mailbox[0]?.message_id);
      assert.equal(requests[0]?.intent, 'pending-mailbox-review');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('queueDirectMailboxMessage keeps leader-fixed missing-pane request pending/deferred', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omc-mcp-comm-'));
    try {
      await initTestTeam('alpha', 1, cwd);

      const outcome = await queueDirectMailboxMessage({
        teamName: 'alpha',
        fromWorker: 'worker-1',
        toWorker: 'leader-fixed',
        body: 'hello leader',
        triggerMessage: 'check leader mailbox',
        cwd,
        transportPreference: 'transport_direct',
        fallbackAllowed: false,
        notify: async () => ({ ok: true, transport: 'mailbox', reason: 'leader_pane_missing_mailbox_persisted' }),
      });

      assert.equal(outcome.ok, true);
      assert.ok(outcome.request_id);
      assert.ok(outcome.message_id);

      const request = await readDispatchRequest('alpha', outcome.request_id!, cwd);
      assert.equal(request?.status, 'pending');
      assert.equal(request?.last_reason, 'leader_pane_missing_deferred');

      const mailbox = await listMailboxMessages('alpha', 'leader-fixed', cwd);
      assert.equal(mailbox.length, 1);
      assert.equal(mailbox[0]?.body, 'hello leader');
      assert.equal(mailbox[0]?.notified_at, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('queueDirectMailboxMessage does not create a new dispatch for an already-notified identical message', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omc-mcp-comm-'));
    try {
      await initTestTeam('alpha-dedupe', 1, cwd);

      const first = await queueDirectMailboxMessage({
        teamName: 'alpha-dedupe',
        fromWorker: 'worker-1',
        toWorker: 'leader-fixed',
        body: 'same-body',
        triggerMessage: 'check mailbox',
        cwd,
        transportPreference: 'transport_direct',
        fallbackAllowed: false,
        notify: async () => ({ ok: true, transport: 'mailbox', reason: 'leader_mailbox_notified' }),
      });

      assert.equal(first.ok, true);
      assert.equal(first.reason, 'leader_mailbox_notified');

      const second = await queueDirectMailboxMessage({
        teamName: 'alpha-dedupe',
        fromWorker: 'worker-1',
        toWorker: 'leader-fixed',
        body: 'same-body',
        triggerMessage: 'check mailbox',
        cwd,
        transportPreference: 'transport_direct',
        fallbackAllowed: false,
        notify: async () => {
          throw new Error('should_not_notify_twice');
        },
      });

      assert.equal(second.ok, true);
      assert.equal(second.reason, 'existing_message_already_notified');

      const mailbox = await listMailboxMessages('alpha-dedupe', 'leader-fixed', cwd);
      assert.equal(mailbox.length, 1);

      const requests = await listDispatchRequests('alpha-dedupe', cwd, { kind: 'mailbox', to_worker: 'leader-fixed' });
      assert.equal(requests.length, 1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('queueBroadcastMailboxMessage notifies and marks notified per recipient', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omc-mcp-comm-'));
    try {
      await initTestTeam('alpha', 2, cwd);

      // Pre-seed a broadcast message set by calling state-layer broadcast through the helper.
      // The helper will call broadcastMessage internally.
      const notified: string[] = [];
      await queueBroadcastMailboxMessage({
        teamName: 'alpha',
        fromWorker: 'worker-1',
        recipients: [
          { workerName: 'worker-1', workerIndex: 1 },
          { workerName: 'worker-2', workerIndex: 2 },
        ],
        body: 'broadcast-body',
        cwd,
        triggerFor: (workerName) => `check mailbox ${workerName}`,
        notify: async (target) => {
          notified.push(target.workerName);
          return { ok: true, transport: 'tmux_send_keys', reason: 'sent' };
        },
      });

      const m1 = await listMailboxMessages('alpha', 'worker-1', cwd);
      const m2 = await listMailboxMessages('alpha', 'worker-2', cwd);
      assert.equal(m1.length, 0);
      assert.equal(m2.length, 1);
      assert.ok(m2[0]?.notified_at);
      assert.deepEqual(notified.sort(), ['worker-2']);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('prevents duplicate pending mailbox dispatch requests for same message id', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omc-mcp-comm-'));
    try {
      await initTestTeam('alpha', 2, cwd);

      const first = await queueDirectMailboxMessage({
        teamName: 'alpha',
        fromWorker: 'worker-1',
        toWorker: 'worker-2',
        toWorkerIndex: 2,
        body: 'hello',
        triggerMessage: 'check mailbox',
        cwd,
        notify: async () => ({ ok: false, transport: 'hook', reason: 'queued_pending' }),
      });

      assert.equal(first.ok, false);
      assert.ok(first.message_id);
      const requests = await listDispatchRequests('alpha', cwd, { kind: 'mailbox' });
      assert.equal(requests.length, 1);

      const second = await queueDirectMailboxMessage({
        teamName: 'alpha',
        fromWorker: 'worker-1',
        toWorker: 'worker-2',
        toWorkerIndex: 2,
        body: 'hello-2',
        triggerMessage: 'check mailbox',
        cwd,
        notify: async () => ({ ok: false, transport: 'hook', reason: 'queued_pending' }),
      });
      assert.equal(second.ok, false);
      const allRequests = await listDispatchRequests('alpha', cwd, { kind: 'mailbox' });
      // second message has distinct message_id -> second request exists
      assert.equal(allRequests.length, 2);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('marks direct dispatch request failed when notify transport fails (prevents poisoned pending)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omc-mcp-comm-'));
    try {
      await initTestTeam('alpha', 1, cwd);

      const first = await queueInboxInstruction({
        teamName: 'alpha',
        workerName: 'worker-1',
        workerIndex: 1,
        inbox: '# hi',
        triggerMessage: 'trigger',
        cwd,
        transportPreference: 'transport_direct',
        fallbackAllowed: false,
        notify: async () => ({ ok: false, transport: 'tmux_send_keys', reason: 'tmux_unavailable' }),
      });
      assert.equal(first.ok, false);
      assert.ok(first.request_id);
      const firstReq = await readDispatchRequest('alpha', first.request_id!, cwd);
      assert.equal(firstReq?.status, 'failed');
      assert.equal(firstReq?.last_reason, 'tmux_unavailable');

      const second = await queueInboxInstruction({
        teamName: 'alpha',
        workerName: 'worker-1',
        workerIndex: 1,
        inbox: '# hi again',
        triggerMessage: 'trigger',
        cwd,
        transportPreference: 'transport_direct',
        fallbackAllowed: false,
        notify: async () => ({ ok: false, transport: 'tmux_send_keys', reason: 'tmux_unavailable' }),
      });
      assert.ok(second.request_id);
      assert.notEqual(second.request_id, first.request_id);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('marks prompt dispatch request failed when notify throws (prevents poisoned pending)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omc-mcp-comm-'));
    try {
      await initTestTeam('alpha', 2, cwd);

      const outcome = await queueDirectMailboxMessage({
        teamName: 'alpha',
        fromWorker: 'worker-1',
        toWorker: 'worker-2',
        toWorkerIndex: 2,
        body: 'hello',
        triggerMessage: 'check mailbox',
        cwd,
        transportPreference: 'prompt_stdin',
        fallbackAllowed: false,
        notify: async () => { throw new Error('stdin closed'); },
      });
      assert.equal(outcome.ok, false);
      assert.match(outcome.reason, /^notify_exception:/);
      assert.ok(outcome.request_id);

      const request = await readDispatchRequest('alpha', outcome.request_id!, cwd);
      assert.equal(request?.status, 'failed');
      assert.match(request?.last_reason ?? '', /^notify_exception:/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
