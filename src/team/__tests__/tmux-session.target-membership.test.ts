import { beforeEach, describe, expect, it, vi } from 'vitest';

// These tests inject the native probe on POSIX only; unsupported platforms
// leave the historical server proof absent and skip only strict tmux positives.
const supportsStrictTmuxFixture = process.platform === 'darwin' || process.platform === 'linux';
const tmuxServerIdentity: TmuxServerIdentity | undefined = supportsStrictTmuxFixture ? {
  socket_path: '/tmp/dispatch-session.sock',
  server_pid: 4242,
  process_started_at: process.platform === 'linux'
    ? 'linux:fixture:4242'
    : 'darwin:4242:123456',
} : undefined;

function strictTmuxIdentity(): TmuxServerIdentity {
  if (!tmuxServerIdentity) throw new Error('strict tmux fixture unsupported on this platform');
  return tmuxServerIdentity;
}

const tmuxUtilsMocks = vi.hoisted(() => ({
  tmuxExecAsync: vi.fn(async () => ({ stdout: '%9\n', stderr: '' })),
  tmuxCmdAsync: vi.fn(async (args: string[]) => {
    const marker = args.join(' ').match(/OMC_TMUX_GUARD_OK_[A-Za-z0-9_]+/)?.[0];
    return {
      stdout: marker ? `${marker}\n` : '4242\n',
      stderr: '',
    };
  }),
}));

vi.mock('../../cli/tmux-utils.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../cli/tmux-utils.js')>(),
  tmuxExecAsync: tmuxUtilsMocks.tmuxExecAsync,
  tmuxCmdAsync: tmuxUtilsMocks.tmuxCmdAsync,
}));

beforeEach(() => {
  tmuxUtilsMocks.tmuxExecAsync.mockClear();
  tmuxUtilsMocks.tmuxCmdAsync.mockClear();
});

import {
  invokeDirectMailboxEffect,
  verifyTeamTargetOwnership,
  type DirectMailboxEffectDependencies,
  type MailboxTargetOwnershipDependencies,
  type TmuxServerIdentityDependencies,
} from '../tmux-session.js';
import type { MailboxNotificationTarget } from '../mailbox-notification-guard.js';
import type { TmuxServerIdentity } from '../types.js';

function workerTarget(overrides: Partial<MailboxNotificationTarget> = {}): MailboxNotificationTarget {
  return {
    provider: 'tmux',
    providerTarget: 'dispatch-session:workers',
    recipient: 'worker-1',
    recipientRole: 'worker',
    paneId: '%9',
    workerIndex: 1,
    ...(tmuxServerIdentity ? { tmuxServerIdentity } : {}),
    ...overrides,
  };
}

function cmuxWorkerTarget(overrides: Partial<MailboxNotificationTarget> = {}): MailboxNotificationTarget {
  return workerTarget({
    provider: 'cmux',
    providerTarget: 'cmux:workspace-1',
    paneId: 'surface-worker-1',
    tmuxServerIdentity: undefined,
    ...overrides,
  });
}

function matchingServerIdentityDependencies(): TmuxServerIdentityDependencies {
  if (!tmuxServerIdentity) {
    return {
      tmuxQuery: vi.fn(async () => ({ stdout: '', stderr: '' })),
      processIdentity: vi.fn(() => null),
      processObservation: vi.fn(() => 'unknown' as const),
    };
  }
  return {
    tmuxQuery: vi.fn(async () => ({ stdout: `${tmuxServerIdentity.server_pid}\n`, stderr: '' })),
    processIdentity: vi.fn(() => tmuxServerIdentity.process_started_at),
    processObservation: vi.fn(() => 'matching' as const),
  };
}

async function withCmuxContext<T>(fn: () => Promise<T>): Promise<T> {
  const previousTmux = process.env.TMUX;
  const previousSurface = process.env.CMUX_SURFACE_ID;
  delete process.env.TMUX;
  process.env.CMUX_SURFACE_ID = 'surface-worker-1';
  try {
    return await fn();
  } finally {
    if (previousTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = previousTmux;
    if (previousSurface === undefined) delete process.env.CMUX_SURFACE_ID;
    else process.env.CMUX_SURFACE_ID = previousSurface;
  }
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
    serverIdentityDependencies: matchingServerIdentityDependencies(),
  };
}

describe('direct mailbox target ownership', () => {
  it.skipIf(!supportsStrictTmuxFixture)('proves exact tmux target membership with an exact session window target', async () => {
    const identity = strictTmuxIdentity();
    const dependencies = ownershipDependencies('%2\n%9\n%9\n');

    const result = await verifyTeamTargetOwnership(workerTarget(), dependencies);

    expect(result).toEqual({
      kind: 'owned',
      provider: 'tmux',
      providerTarget: 'dispatch-session:workers',
      paneId: '%9',
      tmuxServerIdentity: identity,
    });
    expect(dependencies.tmuxExec).toHaveBeenCalledOnce();
    expect(dependencies.serverIdentityDependencies?.tmuxQuery).toHaveBeenCalledWith([
      '-S', identity.socket_path, 'display-message', '-p', '#{pid}',
    ], { timeout: 2_000, stripTmux: true });
    expect(dependencies.serverIdentityDependencies?.processObservation).toHaveBeenCalledWith({
      server_pid: identity.server_pid,
      process_started_at: identity.process_started_at,
    });
    expect(dependencies.tmuxExec).toHaveBeenCalledWith([
      '-S', identity.socket_path,
      'list-panes', '-t', '=dispatch-session:=workers', '-F', '#{pane_id}',
    ]);
    expect(dependencies.cmuxExec).not.toHaveBeenCalled();
  });

  it.skipIf(!supportsStrictTmuxFixture).each([
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

  it.skipIf(!supportsStrictTmuxFixture)('uses an exact session selector for a bare named session', async () => {
    const identity = strictTmuxIdentity();
    const dependencies = ownershipDependencies('%9\n');

    await expect(verifyTeamTargetOwnership(
      workerTarget({ providerTarget: 'dispatch-session' }),
      dependencies,
    )).resolves.toMatchObject({
      kind: 'owned',
      provider: 'tmux',
      tmuxServerIdentity: identity,
    });

    expect(dependencies.tmuxExec).toHaveBeenCalledWith([
      '-S', identity.socket_path,
      'list-panes', '-s', '-t', '=dispatch-session:', '-F', '#{pane_id}',
    ]);
  });

  it.skipIf(!supportsStrictTmuxFixture)('passes native tmux session and window IDs without name prefixes', async () => {
    const identity = strictTmuxIdentity();
    const sessionDependencies = ownershipDependencies('%9\n');
    await expect(verifyTeamTargetOwnership(
      workerTarget({ providerTarget: '$3' }),
      sessionDependencies,
    )).resolves.toMatchObject({ kind: 'owned', tmuxServerIdentity: identity });
    expect(sessionDependencies.tmuxExec).toHaveBeenCalledWith([
      '-S', identity.socket_path,
      'list-panes', '-s', '-t', '$3', '-F', '#{pane_id}',
    ]);

    const windowDependencies = ownershipDependencies('%9\n');
    await expect(verifyTeamTargetOwnership(
      workerTarget({ providerTarget: '@4' }),
      windowDependencies,
    )).resolves.toMatchObject({ kind: 'owned', tmuxServerIdentity: identity });
    expect(windowDependencies.tmuxExec).toHaveBeenCalledWith([
      '-S', identity.socket_path,
      'list-panes', '-t', '@4', '-F', '#{pane_id}',
    ]);
  });

  it('proves exact cmux workspace to pane to surface membership using read-only commands', async () => {
    const dependencies = ownershipDependencies('', [
      JSON.stringify({ panes: [{ id: 'pane-a' }, { id: 'pane-b' }] }),
      JSON.stringify({ surfaces: [{ id: 'surface-other' }] }),
      JSON.stringify({ surfaces: [{ id: 'surface-worker-1' }] }),
    ]);
    const target = cmuxWorkerTarget();

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

    const result = await verifyTeamTargetOwnership(cmuxWorkerTarget({ paneId: '%9' }), dependencies);

    expect(result).toEqual({ kind: 'unavailable' });
    expect(dependencies.tmuxExec).not.toHaveBeenCalled();
    expect(dependencies.cmuxExec).not.toHaveBeenCalled();
  });

  it('rejects provider disagreement without querying either provider', async () => {
    const dependencies = ownershipDependencies('%9\n');

    const result = await verifyTeamTargetOwnership(
      cmuxWorkerTarget({ providerTarget: 'dispatch-session' }),
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

  it('classifies a confirmed CMUX worker effect without changing the public boolean transport', async () => {
    const dependencies = effectDependencies(true);

    const result = await withCmuxContext(() => invokeDirectMailboxEffect(
      cmuxWorkerTarget(),
      'mailbox trigger',
      dependencies,
    ));

    expect(result).toEqual({
      kind: 'confirmed',
      transport: 'tmux_send_keys',
      reason: 'worker_pane_notified',
    });
    expect(dependencies.sendWorker).toHaveBeenCalledWith(
      'cmux:workspace-1',
      'surface-worker-1',
      'mailbox trigger',
    );
    expect(dependencies.sendLeader).not.toHaveBeenCalled();
  });

  it.each([
    [false, 'returned_false'],
    [new Error('transport failed'), 'threw'],
  ])('classifies an invoked but unconfirmed CMUX worker effect', async (workerResult, cause) => {
    const dependencies = effectDependencies(workerResult);

    const result = await withCmuxContext(() => invokeDirectMailboxEffect(
      cmuxWorkerTarget(),
      'mailbox trigger',
      dependencies,
    ));

    expect(result).toEqual({
      kind: 'attempted_unconfirmed',
      transport: 'tmux_send_keys',
      reason: 'notification_delivery_uncertain',
      cause,
    });
    expect(dependencies.sendWorker).toHaveBeenCalledOnce();
  });

  it('uses the leader adapter for a canonical CMUX target', async () => {
    const dependencies = effectDependencies(true, true);
    const target = cmuxWorkerTarget({ recipient: 'leader-fixed', recipientRole: 'leader', workerIndex: undefined });

    const result = await withCmuxContext(() => invokeDirectMailboxEffect(target, 'mailbox trigger', dependencies));

    expect(result).toMatchObject({ kind: 'confirmed', reason: 'leader_pane_notified' });
    expect(dependencies.sendLeader).toHaveBeenCalledOnce();
    expect(dependencies.sendWorker).not.toHaveBeenCalled();
  });

  it('does not route an owned cmux surface through tmux when cmux execution context is absent', async () => {
    const previousSurface = process.env.CMUX_SURFACE_ID;
    const previousTmux = process.env.TMUX;
    delete process.env.CMUX_SURFACE_ID;
    delete process.env.TMUX;
    const dependencies = effectDependencies(true, true);
    const target = cmuxWorkerTarget();

    try {
      const result = await invokeDirectMailboxEffect(target, 'mailbox trigger', dependencies);

      expect(result).toEqual({ kind: 'not_attempted', reason: 'mailbox_membership_unresolvable' });
      expect(dependencies.sendWorker).not.toHaveBeenCalled();
      expect(dependencies.sendLeader).not.toHaveBeenCalled();
    } finally {
      if (previousSurface === undefined) delete process.env.CMUX_SURFACE_ID;
      else process.env.CMUX_SURFACE_ID = previousSurface;
      if (previousTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = previousTmux;
    }
  });

  it('returns not attempted for missing input without invoking either public transport', async () => {
    const dependencies = effectDependencies(true);

    const result = await invokeDirectMailboxEffect(workerTarget(), '', dependencies);

    expect(result).toEqual({ kind: 'not_attempted', reason: 'mailbox_target_missing' });
    expect(dependencies.sendWorker).not.toHaveBeenCalled();
    expect(dependencies.sendLeader).not.toHaveBeenCalled();
  });

  it('returns not attempted for a tmux target without persisted server identity', async () => {
    const dependencies = effectDependencies(true);

    const result = await invokeDirectMailboxEffect(
      workerTarget({ tmuxServerIdentity: undefined }),
      'mailbox trigger',
      dependencies,
    );

    expect(result).toEqual({ kind: 'not_attempted', reason: 'mailbox_membership_unresolvable' });
    expect(dependencies.sendWorker).not.toHaveBeenCalled();
    expect(dependencies.sendLeader).not.toHaveBeenCalled();
    expect(tmuxUtilsMocks.tmuxCmdAsync).not.toHaveBeenCalled();
  });

  it.skipIf(!supportsStrictTmuxFixture)('returns not attempted when the tmux server identity no longer matches', async () => {
    const identity = strictTmuxIdentity();
    const dependencies = effectDependencies(true);
    const serverIdentityDependencies: TmuxServerIdentityDependencies = {
      tmuxQuery: vi.fn(async () => ({ stdout: `${identity.server_pid}\n`, stderr: '' })),
      processIdentity: vi.fn(() => process.platform === 'darwin'
        ? 'darwin:4242:654321'
        : process.platform === 'linux'
          ? 'linux:fixture:654321'
          : 'win32:654321'),
      processObservation: vi.fn(() => 'matching' as const),
    };

    const result = await invokeDirectMailboxEffect(
      workerTarget(),
      'mailbox trigger',
      { ...dependencies, serverIdentityDependencies },
    );

    expect(result).toEqual({ kind: 'not_attempted', reason: 'mailbox_membership_unresolvable' });
    expect(dependencies.sendWorker).not.toHaveBeenCalled();
    expect(dependencies.sendLeader).not.toHaveBeenCalled();
    expect(tmuxUtilsMocks.tmuxCmdAsync).not.toHaveBeenCalled();
  });

  it.skipIf(!supportsStrictTmuxFixture)('uses the persisted tmux identity for native literal and Enter effects', async () => {
    const identity = strictTmuxIdentity();
    const dependencies = {
      ...effectDependencies(true),
      serverIdentityDependencies: matchingServerIdentityDependencies(),
    };

    const result = await invokeDirectMailboxEffect(workerTarget(), 'mailbox trigger', dependencies);

    expect(result).toEqual({
      kind: 'confirmed',
      transport: 'tmux_send_keys',
      reason: 'worker_pane_notified',
    });
    expect(dependencies.sendWorker).not.toHaveBeenCalled();
    expect(tmuxUtilsMocks.tmuxCmdAsync.mock.calls.some(([args]) =>
      args.includes('-S')
      && args.includes(identity.socket_path)
      && args.some(arg => arg.includes('send-keys')),
    )).toBe(true);
  });
});
