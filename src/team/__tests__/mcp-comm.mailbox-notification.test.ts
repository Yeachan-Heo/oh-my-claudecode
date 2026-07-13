import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  queueBroadcastMailboxMessage,
  runMailboxNotificationAttempt,
  type MailboxNotificationAttemptDependencies,
  type MailboxNotificationAttemptParams,
} from '../mcp-comm.js';
import { TeamPaths } from '../state-paths.js';
import type { TeamDispatchRequest } from '../dispatch-queue.js';
import type {
  MailboxNotificationGuardResult,
  MailboxNotificationSecurityTuple,
  MailboxNotificationTarget,
} from '../mailbox-notification-guard.js';
import type { TeamMailboxMessage } from '../types.js';

let sequence = 0;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function params(overrides: Partial<MailboxNotificationAttemptParams> = {}): MailboxNotificationAttemptParams {
  const id = ++sequence;
  return {
    teamName: 'dispatch-team',
    recipient: 'worker-1',
    requestId: `request-${id}`,
    messageId: `message-${id}`,
    triggerMessage: 'Read your mailbox and report progress.',
    cwd: `/mailbox-notification-test-${id}`,
    ...overrides,
  };
}

function request(input: MailboxNotificationAttemptParams, overrides: Partial<TeamDispatchRequest> = {}): TeamDispatchRequest {
  return {
    request_id: input.requestId,
    kind: 'mailbox',
    team_name: input.teamName,
    to_worker: input.recipient,
    worker_index: 1,
    pane_id: '%9',
    trigger_message: input.triggerMessage,
    message_id: input.messageId,
    transport_preference: 'transport_direct',
    fallback_allowed: true,
    status: 'pending',
    attempt_count: 0,
    created_at: '2026-07-13T00:00:00.000Z',
    updated_at: '2026-07-13T00:00:00.000Z',
    ...overrides,
  };
}

function message(input: MailboxNotificationAttemptParams): TeamMailboxMessage {
  return {
    message_id: input.messageId,
    from_worker: 'leader-fixed',
    to_worker: input.recipient,
    body: 'durable mailbox body',
    created_at: '2026-07-13T00:00:00.000Z',
  };
}

function target(input: MailboxNotificationAttemptParams): MailboxNotificationTarget {
  return {
    provider: 'tmux',
    providerTarget: 'dispatch-session:0',
    recipient: input.recipient,
    recipientRole: 'worker',
    paneId: '%9',
    workerIndex: 1,
  };
}

function tuple(input: MailboxNotificationAttemptParams, paneId = '%9'): MailboxNotificationSecurityTuple {
  return {
    configName: input.teamName,
    configProviderTarget: 'dispatch-session:0',
    recipient: input.recipient,
    recipientRole: 'worker',
    canonicalPaneId: paneId,
    canonicalWorkerIndex: 1,
    requestId: input.requestId,
    requestKind: 'mailbox',
    requestTeamName: input.teamName,
    requestRecipient: input.recipient,
    requestMessageId: input.messageId,
    requestTriggerMessage: input.triggerMessage,
    requestPaneId: paneId,
    requestWorkerIndex: 1,
    requestTransportPreference: 'transport_direct',
    requestFallbackAllowed: true,
    requestStatus: 'pending',
    mailboxOwner: input.recipient,
    mailboxMessageId: input.messageId,
    mailboxRecipient: input.recipient,
    provider: 'tmux',
    providerTarget: 'dispatch-session:0',
    providerPaneId: paneId,
  };
}

function allow(input: MailboxNotificationAttemptParams, current: TeamDispatchRequest, paneId = '%9'): MailboxNotificationGuardResult {
  return {
    kind: 'allow',
    target: { ...target(input), paneId },
    request: { ...current, pane_id: paneId },
    message: message(input),
    securityTuple: tuple(input, paneId),
  };
}

function suppress(current: TeamDispatchRequest, reason = 'mailbox_target_metadata_mismatch'): MailboxNotificationGuardResult {
  return { kind: 'suppress', reason: reason as 'mailbox_target_metadata_mismatch', safePendingRequest: current };
}

function serialLock(): MailboxNotificationAttemptDependencies['withRequestLock'] {
  const locks = new Map<string, Promise<void>>();
  return async <T>(path: string, fn: () => Promise<T>): Promise<T> => {
    const previous = locks.get(path) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    locks.set(path, held);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (locks.get(path) === held) locks.delete(path);
    }
  };
}

function harness(input = params(), overrides: Partial<MailboxNotificationAttemptDependencies> = {}) {
  let current = request(input);
  let mailboxMarked = false;
  const effect = vi.fn(async () => ({
    kind: 'confirmed' as const,
    transport: 'tmux_send_keys' as const,
    reason: 'worker_pane_notified' as const,
  }));
  const readGuard = vi.fn(async () => {
    if (current.status !== 'pending' || mailboxMarked) {
      return { kind: 'suppress', reason: 'mailbox_replay_suppressed' } as MailboxNotificationGuardResult;
    }
    return allow(input, current);
  });
  const dependencies: MailboxNotificationAttemptDependencies = {
    readGuard,
    readStrictDispatch: vi.fn(async () => ({ kind: 'valid' as const, request: { ...current } })),
    readStrictMailbox: vi.fn(async () => mailboxMarked
      ? { kind: 'replay_suppressed' as const, message: { ...message(input), notified_at: '2026-07-13T00:01:00.000Z' }, marker: 'notified_at' as const }
      : { kind: 'valid' as const, message: message(input) }),
    invokeEffect: effect,
    markMailbox: vi.fn(async () => {
      mailboxMarked = true;
      return true;
    }),
    markDispatch: vi.fn(async () => {
      current = { ...current, status: 'notified', notified_at: '2026-07-13T00:01:00.000Z' };
      return current;
    }),
    patchPendingReason: vi.fn(async (_teamName, _requestId, reason) => {
      current = { ...current, last_reason: reason };
      return { kind: 'patched' };
    }),
    withRequestLock: serialLock(),
    ...overrides,
  };
  return {
    input,
    dependencies,
    effect,
    readGuard,
    get request() { return current; },
    get mailboxMarked() { return mailboxMarked; },
    markMailbox: (marked: boolean) => { mailboxMarked = marked; },
  };
}

describe('direct mailbox notification orchestration', () => {
  it('hashes the per-request lock name so opaque request text cannot traverse dispatch state', () => {
    const lock = TeamPaths.mailboxNotificationLock('dispatch-team', '../foreign/request');
    expect(lock).toMatch(/^\.omc\/state\/team\/dispatch-team\/dispatch\/\.mailbox-notification-[a-f0-9]{64}\.lock$/);
    expect(lock).not.toContain('foreign');
  });
  it('serializes two waiters after mutation then false without a second transport effect', async () => {
    const state = harness();
    let mutations = 0;
    state.dependencies.invokeEffect = vi.fn(async () => {
      mutations += 1;
      return {
        kind: 'attempted_unconfirmed' as const,
        transport: 'tmux_send_keys' as const,
        reason: 'notification_delivery_uncertain' as const,
        cause: 'returned_false' as const,
      };
    });

    const [first, second] = await Promise.all([
      runMailboxNotificationAttempt(state.input, state.dependencies),
      runMailboxNotificationAttempt(state.input, state.dependencies),
    ]);

    expect(mutations).toBe(1);
    expect(first.reason).toBe('notification_delivery_uncertain');
    expect(second.reason).toBe('notification_delivery_uncertain');
    expect(state.request.status).toBe('pending');
    expect(state.mailboxMarked).toBe(false);
  });

  it('uses canonical lock identity for uncertainty across cwd path aliases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omc-mailbox-alias-'));
    temporaryDirectories.push(root);
    const actualCwd = join(root, 'actual');
    const aliasCwd = join(root, 'alias');
    await mkdir(join(actualCwd, '.omc', 'state', 'team', 'dispatch-team', 'dispatch'), { recursive: true });
    await symlink(actualCwd, aliasCwd, 'dir');
    const state = harness(params({ cwd: actualCwd }));
    state.dependencies.invokeEffect = vi.fn(async () => ({
      kind: 'attempted_unconfirmed' as const,
      transport: 'tmux_send_keys' as const,
      reason: 'notification_delivery_uncertain' as const,
      cause: 'returned_false' as const,
    }));

    const first = await runMailboxNotificationAttempt(state.input, state.dependencies);
    const second = await runMailboxNotificationAttempt({ ...state.input, cwd: aliasCwd }, state.dependencies);

    expect(first.reason).toBe('notification_delivery_uncertain');
    expect(second.reason).toBe('notification_delivery_uncertain');
    expect(state.dependencies.invokeEffect).toHaveBeenCalledTimes(1);
  });

  it('retains delivery uncertainty when the invoked effect throws', async () => {
    const state = harness();
    state.dependencies.invokeEffect = vi.fn(async () => {
      throw new Error('simulated pane mutation followed by throw');
    });

    const first = await runMailboxNotificationAttempt(state.input, state.dependencies);
    const second = await runMailboxNotificationAttempt(state.input, state.dependencies);

    expect(first.reason).toBe('notification_delivery_uncertain');
    expect(second.reason).toBe('notification_delivery_uncertain');
    expect(state.dependencies.invokeEffect).toHaveBeenCalledTimes(1);
    expect(state.request.status).toBe('pending');
  });

  it('removes a tombstone for provable pre-effect suppression so a corrected retry may invoke once', async () => {
    const state = harness();
    state.dependencies.invokeEffect = vi.fn()
      .mockResolvedValueOnce({ kind: 'not_attempted', reason: 'mailbox_target_missing' })
      .mockResolvedValueOnce({ kind: 'confirmed', transport: 'tmux_send_keys', reason: 'worker_pane_notified' });

    const first = await runMailboxNotificationAttempt(state.input, state.dependencies);
    const second = await runMailboxNotificationAttempt(state.input, state.dependencies);

    expect(first.reason).toBe('mailbox_target_missing');
    expect(second.reason).toBe('worker_pane_notified');
    expect(state.dependencies.invokeEffect).toHaveBeenCalledTimes(2);
    expect(state.mailboxMarked).toBe(true);
    expect(state.request.status).toBe('notified');
  });

  it('commits confirmed concurrent delivery exactly once and verifies both durable markers', async () => {
    const state = harness();
    const [first, second] = await Promise.all([
      runMailboxNotificationAttempt(state.input, state.dependencies),
      runMailboxNotificationAttempt(state.input, state.dependencies),
    ]);

    expect(first.reason).toBe('worker_pane_notified');
    expect(second.reason).toBe('mailbox_replay_suppressed');
    expect(state.effect).toHaveBeenCalledTimes(1);
    expect(state.mailboxMarked).toBe(true);
    expect(state.request.status).toBe('notified');
  });

  it('surfaces partial marker failures without retrying the pane effect and retains dual failures as commit uncertainty', async () => {
    const partial = harness();
    partial.dependencies.markMailbox = vi.fn(async () => false);
    const partialOutcome = await runMailboxNotificationAttempt(partial.input, partial.dependencies);
    const partialReplay = await runMailboxNotificationAttempt(partial.input, partial.dependencies);

    expect(partialOutcome.reason).toBe('notification_commit_mailbox_failed');
    expect(partialReplay.reason).toBe('notification_commit_mailbox_failed');
    expect(partial.effect).toHaveBeenCalledTimes(1);

    const dual = harness();
    dual.dependencies.markMailbox = vi.fn(async () => false);
    dual.dependencies.markDispatch = vi.fn(async () => null);
    const dualOutcome = await runMailboxNotificationAttempt(dual.input, dual.dependencies);
    const dualReplay = await runMailboxNotificationAttempt(dual.input, dual.dependencies);

    expect(dualOutcome.reason).toBe('notification_commit_uncertain');
    expect(dualReplay.reason).toBe('notification_commit_uncertain');
    expect(dual.effect).toHaveBeenCalledTimes(1);
  });

  it('reconciles a worker commit missing its mailbox marker without reinvoking transport', async () => {
    const state = harness();
    state.dependencies.markMailbox = vi.fn()
      .mockResolvedValueOnce(false)
      .mockImplementation(async () => {
        state.markMailbox(true);
        return true;
      });

    const partial = await runMailboxNotificationAttempt(state.input, state.dependencies);
    const reconciled = await runMailboxNotificationAttempt(state.input, state.dependencies);

    expect(partial.reason).toBe('notification_commit_mailbox_failed');
    expect(reconciled.reason).toBe('worker_pane_notified');
    expect(state.effect).toHaveBeenCalledTimes(1);
    expect(state.dependencies.markMailbox).toHaveBeenCalledTimes(2);
    expect(state.dependencies.markDispatch).toHaveBeenCalledTimes(1);
    expect(state.mailboxMarked).toBe(true);
    expect(state.request.status).toBe('notified');
  });

  it('reconciles a leader commit missing its dispatch marker without reinvoking transport', async () => {
    const state = harness(params({ recipient: 'leader-fixed' }));
    const effect = vi.fn(async () => ({
      kind: 'confirmed' as const,
      transport: 'tmux_send_keys' as const,
      reason: 'leader_pane_notified' as const,
    }));
    state.dependencies.invokeEffect = effect;
    const markDispatch = state.dependencies.markDispatch;
    let firstDispatch = true;
    state.dependencies.markDispatch = vi.fn(async (
      resolvedTeamName: string,
      requestId: string,
      resolvedCwd: string,
    ) => {
      if (firstDispatch) {
        firstDispatch = false;
        return null;
      }
      return markDispatch(resolvedTeamName, requestId, resolvedCwd);
    });

    const partial = await runMailboxNotificationAttempt(state.input, state.dependencies);
    const reconciled = await runMailboxNotificationAttempt(state.input, state.dependencies);

    expect(partial.reason).toBe('notification_commit_dispatch_failed');
    expect(reconciled.reason).toBe('leader_pane_notified');
    expect(effect).toHaveBeenCalledTimes(1);
    expect(state.dependencies.markMailbox).toHaveBeenCalledTimes(1);
    expect(state.dependencies.markDispatch).toHaveBeenCalledTimes(2);
    expect(state.mailboxMarked).toBe(true);
    expect(state.request.status).toBe('notified');
  });

  it('reconciles a tombstone through markers only and never invokes transport again', async () => {
    const state = harness();
    state.dependencies.invokeEffect = vi.fn(async () => ({
      kind: 'attempted_unconfirmed' as const,
      transport: 'tmux_send_keys' as const,
      reason: 'notification_delivery_uncertain' as const,
      cause: 'returned_false' as const,
    }));

    await runMailboxNotificationAttempt(state.input, state.dependencies);
    state.markMailbox(true);
    const reconciled = await runMailboxNotificationAttempt(state.input, state.dependencies);

    expect(reconciled.reason).toBe('notification_commit_dispatch_failed');
    expect(state.dependencies.invokeEffect).toHaveBeenCalledTimes(1);
    expect(state.dependencies.markDispatch).not.toHaveBeenCalled();
  });

  it('suppresses final current-state or security-tuple changes before installing an effect tombstone', async () => {
    const stateChange = harness();
    stateChange.dependencies.readGuard = vi.fn()
      .mockResolvedValueOnce(allow(stateChange.input, stateChange.request))
      .mockResolvedValueOnce(suppress(stateChange.request));

    const changedState = await runMailboxNotificationAttempt(stateChange.input, stateChange.dependencies);
    expect(changedState.reason).toBe('mailbox_target_metadata_mismatch');
    expect(stateChange.effect).not.toHaveBeenCalled();

    const tupleChange = harness();
    tupleChange.dependencies.readGuard = vi.fn()
      .mockResolvedValueOnce(allow(tupleChange.input, tupleChange.request))
      .mockResolvedValueOnce(allow(tupleChange.input, tupleChange.request, '%10'));

    const changedTuple = await runMailboxNotificationAttempt(tupleChange.input, tupleChange.dependencies);
    expect(changedTuple.reason).toBe('mailbox_security_tuple_changed');
    expect(tupleChange.effect).not.toHaveBeenCalled();
  });

  it('surfaces pending-reason persistence failures without calling transport', async () => {
    const state = harness();
    state.dependencies.readGuard = vi.fn(async () => suppress(state.request, 'mailbox_target_metadata_mismatch'));
    state.dependencies.patchPendingReason = vi.fn(async () => ({ kind: 'write_failed' }));

    const outcome = await runMailboxNotificationAttempt(state.input, state.dependencies);

    expect(outcome.reason).toBe('pending_reason_persist_failed');
    expect(state.effect).not.toHaveBeenCalled();
  });

  it('does not recurse through the request lock while safely patching a pending reason', async () => {
    const state = harness();
    let lockDepth = 0;
    let maximumLockDepth = 0;
    state.dependencies.readGuard = vi.fn(async () => suppress(state.request, 'mailbox_target_metadata_mismatch'));
    state.dependencies.withRequestLock = async <T>(_path: string, fn: () => Promise<T>): Promise<T> => {
      lockDepth += 1;
      maximumLockDepth = Math.max(maximumLockDepth, lockDepth);
      try {
        return await fn();
      } finally {
        lockDepth -= 1;
      }
    };
    state.dependencies.patchPendingReason = vi.fn(async () => {
      expect(lockDepth).toBe(1);
      return { kind: 'patched' };
    });

    const outcome = await runMailboxNotificationAttempt(state.input, state.dependencies);

    expect(outcome.reason).toBe('mailbox_target_metadata_mismatch');
    expect(maximumLockDepth).toBe(1);
  });

  it('uses the broadcast recipient snapshot 1:1 and surfaces a persisted recipient divergence', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omc-mcp-broadcast-'));
    temporaryDirectories.push(cwd);
    await mkdir(join(cwd, '.omc', 'state', 'team', 'dispatch-team'), { recursive: true });

    let nextMessage = 0;
    const effects: string[] = [];
    const outcomes = await queueBroadcastMailboxMessage({
      teamName: 'dispatch-team',
      fromWorker: 'leader-fixed',
      recipients: [
        { workerName: 'worker-1', workerIndex: 1, paneId: '%9' },
        { workerName: 'worker-2', workerIndex: 2, paneId: '%10' },
      ],
      body: 'broadcast body',
      cwd,
      triggerFor: (workerName) => `Read mailbox for ${workerName}.`,
      notify: vi.fn(async () => {
        effects.push('notify');
        return { ok: true, transport: 'hook' as const, reason: 'queued_for_hook_dispatch' };
      }),
      deps: {
        sendDirectMessage: vi.fn(async (_teamName, _fromWorker, toWorker) => {
          effects.push(`persist:${toWorker}`);
          return {
            message_id: `broadcast-${++nextMessage}`,
            to_worker: nextMessage === 2 ? 'worker-foreign' : toWorker,
          };
        }),
        broadcastMessage: vi.fn(async () => []),
        markMessageNotified: vi.fn(async () => true),
      },
    });

    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]).toMatchObject({ to_worker: 'worker-1', reason: 'queued_for_hook_dispatch' });
    expect(outcomes[1]).toMatchObject({ to_worker: 'worker-2', reason: 'broadcast_recipient_diverged' });
    expect(effects).toEqual(['persist:worker-1', 'persist:worker-2', 'notify']);
  });

  it('does not notify a broadcast when persisting the second recipient fails', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omc-mcp-broadcast-'));
    temporaryDirectories.push(cwd);
    await mkdir(join(cwd, '.omc', 'state', 'team', 'dispatch-team'), { recursive: true });
    const notify = vi.fn(async () => ({ ok: true, transport: 'hook' as const, reason: 'queued_for_hook_dispatch' }));

    await expect(queueBroadcastMailboxMessage({
      teamName: 'dispatch-team',
      fromWorker: 'leader-fixed',
      recipients: [
        { workerName: 'worker-1', workerIndex: 1, paneId: '%9' },
        { workerName: 'worker-2', workerIndex: 2, paneId: '%10' },
      ],
      body: 'broadcast body',
      cwd,
      triggerFor: (workerName) => `Read mailbox for ${workerName}.`,
      notify,
      deps: {
        sendDirectMessage: vi.fn(async (_teamName, _fromWorker, toWorker) => {
          if (toWorker === 'worker-2') throw new Error('persist recipient 2 failed');
          return { message_id: 'broadcast-1', to_worker: toWorker };
        }),
        broadcastMessage: vi.fn(async () => []),
        markMessageNotified: vi.fn(async () => true),
      },
    })).rejects.toThrow('persist recipient 2 failed');

    expect(notify).not.toHaveBeenCalled();
  });
});
