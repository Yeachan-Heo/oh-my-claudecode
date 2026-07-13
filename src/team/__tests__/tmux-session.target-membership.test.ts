import { describe, expect, it, vi } from 'vitest';

import {
  invokeDirectMailboxEffect,
  verifyTeamTargetOwnership,
  type DirectMailboxEffectDependencies,
  type MailboxTargetOwnershipDependencies,
} from '../tmux-session.js';
import type { MailboxNotificationTarget } from '../mailbox-notification-guard.js';

function workerTarget(overrides: Partial<MailboxNotificationTarget> = {}): MailboxNotificationTarget {
  return {
    provider: 'tmux',
    providerTarget: 'dispatch-session:workers',
    recipient: 'worker-1',
    recipientRole: 'worker',
    paneId: '%9',
    workerIndex: 1,
    ...overrides,
  };
}

function ownershipDependencies(
  tmuxOutput: string = '',
  cmuxOutputs: string[] = [],
): MailboxTargetOwnershipDependencies & {
  tmuxExec: ReturnType<typeof vi.fn>;
  cmuxExec: ReturnType<typeof vi.fn>;
} {
  const outputs = [...cmuxOutputs];
  return {
    tmuxExec: vi.fn(async () => ({ stdout: tmuxOutput, stderr: '' })),
    cmuxExec: vi.fn(async () => ({ stdout: outputs.shift() ?? '', stderr: '' })),
  };
}

describe('direct mailbox target ownership', () => {
  it('proves exact tmux target membership with the unchanged session window target', async () => {
    const dependencies = ownershipDependencies('%2\n%9\n%9\n');

    const result = await verifyTeamTargetOwnership(workerTarget(), dependencies);

    expect(result).toEqual({
      kind: 'owned',
      provider: 'tmux',
      providerTarget: 'dispatch-session:workers',
      paneId: '%9',
    });
    expect(dependencies.tmuxExec).toHaveBeenCalledOnce();
    expect(dependencies.tmuxExec).toHaveBeenCalledWith([
      'list-panes', '-t', 'dispatch-session:workers', '-F', '#{pane_id}',
    ]);
    expect(dependencies.cmuxExec).not.toHaveBeenCalled();
  });

  it.each([
    ['', 'unavailable'],
    ['%2\nnot-a-pane\n%9\n', 'unavailable'],
    ['%2\n%3\n', 'foreign'],
  ])('fails closed for tmux output %j', async (stdout, expectedKind) => {
    const dependencies = ownershipDependencies(stdout);

    const result = await verifyTeamTargetOwnership(workerTarget(), dependencies);

    expect(result.kind).toBe(expectedKind);
  });

  it('rejects malformed tmux target metadata without executing a provider command', async () => {
    const dependencies = ownershipDependencies('%9\n');

    const result = await verifyTeamTargetOwnership(
      workerTarget({ providerTarget: 'dispatch-session:workers:extra' }),
      dependencies,
    );

    expect(result).toEqual({ kind: 'unavailable' });
    expect(dependencies.tmuxExec).not.toHaveBeenCalled();
  });

  it('proves exact cmux workspace to pane to surface membership using read-only commands', async () => {
    const dependencies = ownershipDependencies('', [
      JSON.stringify({ panes: [{ id: 'pane-a' }, { id: 'pane-b' }] }),
      JSON.stringify({ surfaces: [{ id: 'surface-other' }] }),
      JSON.stringify({ surfaces: [{ id: 'surface-worker-1' }] }),
    ]);
    const target = workerTarget({
      provider: 'cmux',
      providerTarget: 'cmux:workspace-1',
      paneId: 'surface-worker-1',
    });

    const result = await verifyTeamTargetOwnership(target, dependencies);

    expect(result).toEqual({
      kind: 'owned',
      provider: 'cmux',
      providerTarget: 'cmux:workspace-1',
      paneId: 'surface-worker-1',
    });
    expect(dependencies.cmuxExec.mock.calls).toEqual([
      [['--json', 'list-panes', '--workspace', 'workspace-1']],
      [['--json', 'list-pane-surfaces', '--workspace', 'workspace-1', '--pane', 'pane-a']],
      [['--json', 'list-pane-surfaces', '--workspace', 'workspace-1', '--pane', 'pane-b']],
    ]);
    expect(dependencies.tmuxExec).not.toHaveBeenCalled();
  });

  it('rejects a tmux-shaped cmux surface before any provider query', async () => {
    const dependencies = ownershipDependencies('', [
      JSON.stringify({ panes: [{ id: 'pane-a' }] }),
      JSON.stringify({ surfaces: [{ id: '%9' }] }),
    ]);

    const result = await verifyTeamTargetOwnership(workerTarget({
      provider: 'cmux',
      providerTarget: 'cmux:workspace-1',
      paneId: '%9',
    }), dependencies);

    expect(result).toEqual({ kind: 'unavailable' });
    expect(dependencies.tmuxExec).not.toHaveBeenCalled();
    expect(dependencies.cmuxExec).not.toHaveBeenCalled();
  });

  it('rejects provider disagreement without querying either provider', async () => {
    const dependencies = ownershipDependencies('%9\n');

    const result = await verifyTeamTargetOwnership(
      workerTarget({ provider: 'cmux', providerTarget: 'dispatch-session' }),
      dependencies,
    );

    expect(result).toEqual({ kind: 'provider_mismatch' });
    expect(dependencies.tmuxExec).not.toHaveBeenCalled();
    expect(dependencies.cmuxExec).not.toHaveBeenCalled();
  });
});

describe('direct mailbox effect adapter', () => {
  function effectDependencies(
    workerResult: boolean | Error,
    leaderResult: boolean | Error = true,
  ): DirectMailboxEffectDependencies & {
    sendWorker: ReturnType<typeof vi.fn>;
    sendLeader: ReturnType<typeof vi.fn>;
  } {
    return {
      sendWorker: vi.fn(async () => {
        if (workerResult instanceof Error) throw workerResult;
        return workerResult;
      }),
      sendLeader: vi.fn(async () => {
        if (leaderResult instanceof Error) throw leaderResult;
        return leaderResult;
      }),
    };
  }

  it('classifies a confirmed worker effect without changing the public boolean transport', async () => {
    const dependencies = effectDependencies(true);

    const result = await invokeDirectMailboxEffect(workerTarget(), 'mailbox trigger', dependencies);

    expect(result).toEqual({
      kind: 'confirmed',
      transport: 'tmux_send_keys',
      reason: 'worker_pane_notified',
    });
    expect(dependencies.sendWorker).toHaveBeenCalledOnce();
    expect(dependencies.sendLeader).not.toHaveBeenCalled();
  });

  it.each([
    [false, 'returned_false'],
    [new Error('transport failed'), 'threw'],
  ])('classifies an invoked but unconfirmed worker effect', async (workerResult, cause) => {
    const dependencies = effectDependencies(workerResult);

    const result = await invokeDirectMailboxEffect(workerTarget(), 'mailbox trigger', dependencies);

    expect(result).toEqual({
      kind: 'attempted_unconfirmed',
      transport: 'tmux_send_keys',
      reason: 'notification_delivery_uncertain',
      cause,
    });
    expect(dependencies.sendWorker).toHaveBeenCalledOnce();
  });

  it('uses the leader adapter for a canonical leader target', async () => {
    const dependencies = effectDependencies(true, true);
    const target = workerTarget({ recipient: 'leader-fixed', recipientRole: 'leader', workerIndex: undefined });

    const result = await invokeDirectMailboxEffect(target, 'mailbox trigger', dependencies);

    expect(result).toMatchObject({ kind: 'confirmed', reason: 'leader_pane_notified' });
    expect(dependencies.sendLeader).toHaveBeenCalledOnce();
    expect(dependencies.sendWorker).not.toHaveBeenCalled();
  });

  it('does not route an owned cmux surface through tmux when cmux execution context is absent', async () => {
    const previousSurface = process.env.CMUX_SURFACE_ID;
    delete process.env.CMUX_SURFACE_ID;
    const dependencies = effectDependencies(true, true);
    const target = workerTarget({
      provider: 'cmux',
      providerTarget: 'cmux:workspace-1',
      paneId: 'surface-worker-1',
    });

    try {
      const result = await invokeDirectMailboxEffect(target, 'mailbox trigger', dependencies);

      expect(result).toEqual({ kind: 'not_attempted', reason: 'mailbox_membership_unresolvable' });
      expect(dependencies.sendWorker).not.toHaveBeenCalled();
      expect(dependencies.sendLeader).not.toHaveBeenCalled();
    } finally {
      if (previousSurface === undefined) delete process.env.CMUX_SURFACE_ID;
      else process.env.CMUX_SURFACE_ID = previousSurface;
    }
  });

  it('returns not attempted for missing input without invoking either public transport', async () => {
    const dependencies = effectDependencies(true);

    const result = await invokeDirectMailboxEffect(workerTarget(), '', dependencies);

    expect(result).toEqual({ kind: 'not_attempted', reason: 'mailbox_target_missing' });
    expect(dependencies.sendWorker).not.toHaveBeenCalled();
    expect(dependencies.sendLeader).not.toHaveBeenCalled();
  });
});
