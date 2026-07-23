import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { atomicWriteJsonSync } from '../../lib/atomic-write.js';
import {
  ControlOwnerError,
  ControlOwnerStore,
  classifyControlMode,
  type ControlOwnerDependencies,
} from '../control-owner.js';

const temporaryDirectories: string[] = [];
const GRAPH_REVISION = { revision_id: 'revision-1', revision_hash: 'a'.repeat(64) };

function createStore(
  events: string[] = [],
  withExclusiveLock: ControlOwnerDependencies['withExclusiveLock'] = (_path, callback) => {
    events.push('lock');
    return { acquired: true, value: callback() };
  },
) {
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'omc-control-owner-'));
  temporaryDirectories.push(worktreeRoot);
  return new ControlOwnerStore({
    sessionId: 'session-control',
    worktreeRoot,
    platform: {
      preflight: () => {
        events.push('preflight');
        return { pid: 123, process_start: '456' };
      },
      isProcessIdentityLive: () => false,
    },
    dependencies: {
      fileExists: (path) => {
        events.push('read');
        return existsSync(path);
      },
      readText: (path) => readFileSync(path, 'utf8'),
      writeAtomic: atomicWriteJsonSync,
      withExclusiveLock,
    },
  });
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('ControlOwnerStore', () => {
  it('preflights before reservation and gives competing roots one winner', () => {
    const events: string[] = [];
    const store = createStore(events);
    const reserved = store.reserveRoot({
      mode: 'graph',
      run_id: 'run-1',
      nonce: 'nonce-1',
      reserved_at: '2026-07-21T00:00:00.000Z',
      graph_revision: GRAPH_REVISION,
    });

    expect(events.slice(0, 2)).toEqual(['preflight', 'lock']);
    expect(reserved.root).toMatchObject({ mode: 'graph', phase: 'reserved', nonce: 'nonce-1' });
    expect(() => store.reserveRoot({
      mode: 'autopilot',
      run_id: 'autopilot-1',
      nonce: 'nonce-2',
      reserved_at: '2026-07-21T00:00:01.000Z',
    })).toThrowError(ControlOwnerError);
  });

  it('renews the lease immediately before publishing control ownership', () => {
    const renew = vi.fn();
    const store = createStore([], (_path, callback) => ({ acquired: true, value: callback(renew) }));

    store.reserveRoot({
      mode: 'graph',
      run_id: 'run-renew',
      nonce: 'nonce-renew',
      reserved_at: '2026-07-21T00:00:00.000Z',
      graph_revision: GRAPH_REVISION,
    });

    expect(renew).toHaveBeenCalledTimes(1);
  });

  it('accepts a pid-only reservation_process (empty process_start) so a host that could not capture start time does not wedge control authority', () => {
    // When ps/powershell/proc is unavailable at reservation time, preflight()
    // returns process_start: ''. The store must still accept the reserved
    // control state on read() (pid-only identity) instead of rejecting it as
    // malformed_control, which would permanently break control authority.
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'omc-control-owner-pidonly-'));
    temporaryDirectories.push(worktreeRoot);
    const store = new ControlOwnerStore({
      sessionId: 'session-pidonly',
      worktreeRoot,
      platform: {
        preflight: () => ({ pid: 999, process_start: '' }),
        isProcessIdentityLive: () => true,
      },
      dependencies: {
        fileExists: (path) => existsSync(path),
        readText: (path) => readFileSync(path, 'utf8'),
        writeAtomic: atomicWriteJsonSync,
        withExclusiveLock: (_path, callback) => ({ acquired: true, value: callback() }),
      },
    });

    const reserved = store.reserveRoot({
      mode: 'autopilot',
      run_id: 'run-pidonly',
      nonce: 'nonce-pidonly',
      reserved_at: '2026-07-21T00:00:00.000Z',
    });

    expect(reserved.root?.reservation_process).toEqual({ pid: 999, process_start: '' });
    // read() must not throw malformed_control for the pid-only form.
    const reloaded = store.read();
    expect(reloaded?.root?.reservation_process).toEqual({ pid: 999, process_start: '' });
  });

  it('gives concurrent root reservations exactly one winner', async () => {
    const store = createStore();
    const results = await Promise.allSettled(
      (['graph', 'ralph', 'autopilot', 'team'] as const).map((mode, index) =>
        Promise.resolve().then(() => store.reserveRoot({
          mode,
          run_id: `${mode}-run`,
          nonce: `nonce-${index}`,
          reserved_at: '2026-07-21T00:00:00.000Z',
          ...(mode === 'graph' ? { graph_revision: GRAPH_REVISION } : {}),
        })),
      ),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(3);
    expect(store.read()?.root).not.toBeNull();
  });

  it('recovers reserve-create-promote and fences a stale releaser by nonce', () => {
    const store = createStore();
    store.reserveRoot({
      mode: 'graph',
      run_id: 'run-1',
      nonce: 'nonce-1',
      reserved_at: '2026-07-21T00:00:00.000Z',
      graph_revision: GRAPH_REVISION,
    });
    expect(() => store.recoverGraphReservation({
      session_id: 'session-control',
      run_id: 'run-1',
      revision_id: 'revision-1',
      revision_hash: 'b'.repeat(64),
      status: 'running',
      reservation_nonce: 'nonce-1',
      observed_at: '2026-07-21T00:00:00.500Z',
      driver_lease: {
        driver_instance_id: 'driver-1',
        lease_id: 'driver-lease-1',
        expires_at: '2026-07-21T00:01:00.500Z',
      },
    })).toThrow(/revision\/hash/i);
    const recovered = store.recoverGraphReservation({
      session_id: 'session-control',
      run_id: 'run-1',
      revision_id: 'revision-1',
      revision_hash: 'a'.repeat(64),
      status: 'running',
      reservation_nonce: 'nonce-1',
      observed_at: '2026-07-21T00:00:01.000Z',
      driver_lease: {
        driver_instance_id: 'driver-1',
        lease_id: 'driver-lease-1',
        expires_at: '2026-07-21T00:01:01.000Z',
      },
    });
    expect(recovered.action).toBe('promoted');
    expect(store.read()?.root?.phase).toBe('active');

    const stale = store.releaseRoot({
      mode: 'graph',
      run_id: 'run-1',
      nonce: 'stale-nonce',
      disposition: {
        graph_status: 'paused',
        claims_fenced: true,
        children_drained: true,
      },
      released_at: '2026-07-21T00:00:02.000Z',
    });
    expect(stale.released).toBe(false);
    expect(store.read()?.root?.nonce).toBe('nonce-1');
  });

  it('permits only declared exact-lineage children', () => {
    const store = createStore();
    store.reserveRoot({
      mode: 'graph',
      run_id: 'run-1',
      nonce: 'nonce-1',
      reserved_at: '2026-07-21T00:00:00.000Z',
      graph_revision: GRAPH_REVISION,
    });
    store.promoteRoot({
      mode: 'graph',
      run_id: 'run-1',
      nonce: 'nonce-1',
      promoted_at: '2026-07-21T00:00:01.000Z',
      driver_lease: {
        driver_instance_id: 'driver-1',
        lease_id: 'driver-lease-1',
        expires_at: '2026-07-21T00:01:01.000Z',
      },
    });
    const registered = store.registerChild({
      mode: 'team',
      session_id: 'team-session',
      run_id: 'team-run',
      parent: { mode: 'graph', session_id: 'session-control', run_id: 'run-1' },
      graph_claim: {
        activation_id: 'activation-a',
        attempt_id: 'attempt-a',
        lease_id: 'lease-a',
        revision_id: 'revision-1',
        revision_hash: 'a'.repeat(64),
        dispatch_generation: 0,
      },
      registered_at: '2026-07-21T00:00:02.000Z',
    });
    expect(registered.root?.children).toHaveLength(1);

    expect(() => store.registerChild({
      mode: 'ralph',
      session_id: 'ralph-session',
      run_id: 'ralph-run',
      parent: { mode: 'graph', session_id: 'session-control', run_id: 'run-1' },
      registered_at: '2026-07-21T00:00:03.000Z',
    })).toThrow(/lineage/i);
  });

  it('rejects persisted cyclic lineage and Graph children without exact claims', () => {
    const cyclic = createStore();
    cyclic.reserveRoot({
      mode: 'autopilot', run_id: 'auto-run', nonce: 'nonce-auto',
      reserved_at: '2026-07-21T00:00:00.000Z',
    });
    const cyclicState = cyclic.read()!;
    atomicWriteJsonSync(cyclic.path, {
      ...cyclicState,
      root: {
        ...cyclicState.root!,
        children: [{
          mode: 'ralph', session_id: 'session-control', run_id: 'ralph-run',
          parent: { mode: 'ultrawork', session_id: 'session-control', run_id: 'uw-run' },
          registered_at: '2026-07-21T00:00:01.000Z',
        }, {
          mode: 'ultrawork', session_id: 'session-control', run_id: 'uw-run',
          parent: { mode: 'ralph', session_id: 'session-control', run_id: 'ralph-run' },
          registered_at: '2026-07-21T00:00:01.000Z',
        }],
      },
    });
    expect(() => cyclic.read()).toThrow(/reachable|lineage/i);

    const missingClaim = createStore();
    missingClaim.reserveRoot({
      mode: 'graph', run_id: 'graph-run', nonce: 'nonce-graph',
      graph_revision: GRAPH_REVISION,
      reserved_at: '2026-07-21T00:00:00.000Z',
    });
    const graphState = missingClaim.read()!;
    atomicWriteJsonSync(missingClaim.path, {
      ...graphState,
      root: {
        ...graphState.root!,
        children: [{
          mode: 'team', session_id: 'team-session', run_id: 'team-run',
          parent: { mode: 'graph', session_id: 'session-control', run_id: 'graph-run' },
          registered_at: '2026-07-21T00:00:01.000Z',
        }],
      },
    });
    expect(() => missingClaim.read()).toThrow(/claim/i);
  });

  it('implements the full Autopilot and Ralph child matrix and rejects mismatched parents', () => {
    const autopilot = createStore();
    autopilot.reserveRoot({
      mode: 'autopilot', run_id: 'autopilot-run', nonce: 'nonce-auto',
      reserved_at: '2026-07-21T00:00:00.000Z',
    });
    autopilot.promoteRoot({
      mode: 'autopilot', run_id: 'autopilot-run', nonce: 'nonce-auto',
      promoted_at: '2026-07-21T00:00:01.000Z',
      driver_lease: {
        driver_instance_id: 'driver-auto', lease_id: 'lease-auto',
        expires_at: '2026-07-21T00:01:01.000Z',
      },
    });
    for (const mode of ['ralph', 'team', 'ultrawork', 'ultraqa', 'ralplan', 'deep-interview'] as const) {
      autopilot.registerChild({
        mode,
        session_id: `${mode}-session`,
        run_id: `${mode}-run`,
        parent: { mode: 'autopilot', session_id: 'session-control', run_id: 'autopilot-run' },
        registered_at: '2026-07-21T00:00:02.000Z',
      });
    }
    expect(autopilot.read()?.root?.children).toHaveLength(6);
    expect(() => autopilot.registerChild({
      mode: 'team',
      session_id: 'bad-session',
      run_id: 'bad-run',
      parent: { mode: 'autopilot', session_id: 'session-control', run_id: 'wrong-run' },
      registered_at: '2026-07-21T00:00:03.000Z',
    })).toThrow(/parent lineage/i);

    const ralph = createStore();
    ralph.reserveRoot({
      mode: 'ralph', run_id: 'ralph-root', nonce: 'nonce-ralph',
      reserved_at: '2026-07-21T00:00:00.000Z',
    });
    ralph.promoteRoot({
      mode: 'ralph', run_id: 'ralph-root', nonce: 'nonce-ralph',
      promoted_at: '2026-07-21T00:00:01.000Z',
      driver_lease: {
        driver_instance_id: 'driver-ralph', lease_id: 'lease-ralph',
        expires_at: '2026-07-21T00:01:01.000Z',
      },
    });
    for (const mode of ['team', 'ultrawork', 'ultraqa', 'ralplan'] as const) {
      ralph.registerChild({
        mode,
        session_id: `${mode}-session`,
        run_id: `${mode}-run`,
        parent: { mode: 'ralph', session_id: 'session-control', run_id: 'ralph-root' },
        registered_at: '2026-07-21T00:00:02.000Z',
      });
    }
    expect(ralph.read()?.root?.children).toHaveLength(4);
  });

  it('represents Autopilot -> Ralph -> Ultrawork as one exact tree', () => {
    const store = createStore();
    store.reserveRoot({
      mode: 'autopilot', run_id: 'auto', nonce: 'nonce-auto',
      reserved_at: '2026-07-21T00:00:00.000Z',
    });
    store.promoteRoot({
      mode: 'autopilot', run_id: 'auto', nonce: 'nonce-auto',
      promoted_at: '2026-07-21T00:00:01.000Z',
      driver_lease: {
        driver_instance_id: 'driver', lease_id: 'driver-lease',
        expires_at: '2026-07-21T00:01:01.000Z',
      },
    });
    store.registerChild({
      mode: 'ralph', session_id: 'session-control', run_id: 'ralph-child',
      parent: { mode: 'autopilot', session_id: 'session-control', run_id: 'auto' },
      registered_at: '2026-07-21T00:00:02.000Z',
    });
    store.registerChild({
      mode: 'ultrawork', session_id: 'session-control', run_id: 'uw-child',
      parent: { mode: 'ralph', session_id: 'session-control', run_id: 'ralph-child' },
      registered_at: '2026-07-21T00:00:03.000Z',
    });

    expect(store.read()?.root?.children.map((child) => child.parent.mode)).toEqual([
      'autopilot',
      'ralph',
    ]);
    expect(() => store.registerChild({
      mode: 'ultrawork', session_id: 'session-control', run_id: 'uw-child',
      parent: { mode: 'autopilot', session_id: 'session-control', run_id: 'auto' },
      registered_at: '2026-07-21T00:00:04.000Z',
    })).toThrow(/already registered/i);
  });

  it('resumes only the exact paused graph run with a new nonce', () => {
    const store = createStore();
    store.reserveRoot({
      mode: 'graph',
      run_id: 'run-1',
      nonce: 'old-nonce',
      reserved_at: '2026-07-21T00:00:00.000Z',
      graph_revision: GRAPH_REVISION,
    });
    store.promoteRoot({
      mode: 'graph',
      run_id: 'run-1',
      nonce: 'old-nonce',
      promoted_at: '2026-07-21T00:00:01.000Z',
      driver_lease: {
        driver_instance_id: 'driver-1',
        lease_id: 'driver-lease-1',
        expires_at: '2026-07-21T00:01:01.000Z',
      },
    });
    expect(store.releaseRoot({
      mode: 'graph',
      run_id: 'run-1',
      nonce: 'old-nonce',
      disposition: { graph_status: 'paused', claims_fenced: true, children_drained: true },
      released_at: '2026-07-21T00:00:02.000Z',
    }).released).toBe(true);

    const resumed = store.reservePausedGraph({
      run_id: 'run-1',
      revision_id: 'revision-1',
      revision_hash: 'a'.repeat(64),
      nonce: 'new-nonce',
      graph_state: {
        session_id: 'session-control',
        run_id: 'run-1',
        revision_id: 'revision-1',
        status: 'paused',
      },
      reserved_at: '2026-07-21T00:00:03.000Z',
    });
    expect(resumed.root?.nonce).toBe('new-nonce');
    expect(store.releaseRoot({
      mode: 'graph',
      run_id: 'run-1',
      nonce: 'old-nonce',
      disposition: { graph_status: 'paused', claims_fenced: true, children_drained: true },
      released_at: '2026-07-21T00:00:04.000Z',
    }).released).toBe(false);
  });

  it('classifies every canonical persistent control surface exhaustively', () => {
    for (const mode of [
      'graph',
      'autopilot',
      'autoresearch',
      'ralph',
      'team',
      'ultrawork',
      'ultraqa',
      'ralplan',
      'deep-interview',
      'self-improve',
    ] as const) {
      expect(classifyControlMode(mode)).toBe('root');
    }
    expect(classifyControlMode('merge-readiness')).toBe('non_owner');
    expect(classifyControlMode('skill-active')).toBe('non_owner');
    expect(classifyControlMode('unknown-mode')).toBe('unknown');
  });

  it('adopts one identity-complete legacy root and rejects multiple roots', () => {
    const single = createStore();
    const adopted = single.adoptLegacyRoots({
      nonce: 'legacy-nonce',
      adopted_at: '2026-07-21T00:00:00.000Z',
      candidates: [{
        mode: 'autopilot', session_id: 'session-control', run_id: 'auto-run', active: true,
      }],
    });
    expect(adopted.root).toMatchObject({ mode: 'autopilot', run_id: 'auto-run', phase: 'active' });

    const conflicting = createStore();
    expect(() => conflicting.adoptLegacyRoots({
      nonce: 'legacy-conflict',
      adopted_at: '2026-07-21T00:00:00.000Z',
      candidates: [
        { mode: 'autopilot', session_id: 'session-control', run_id: 'auto-run', active: true },
        { mode: 'team', session_id: 'session-control', run_id: 'team-run', active: true },
      ],
    })).toThrow(/exactly one legacy root/i);
  });

  it('adopts legacy Ralph/Ultrawork only with mutual exact links', () => {
    const candidates = [{
      mode: 'ralph' as const,
      session_id: 'session-control',
      run_id: 'ralph-run',
      active: true,
      linked_ultrawork: true,
    }, {
      mode: 'ultrawork' as const,
      session_id: 'session-control',
      run_id: 'uw-run',
      active: true,
      linked_to_ralph: true,
      parent: { mode: 'ralph' as const, session_id: 'session-control', run_id: 'ralph-run' },
    }];
    const matched = createStore().adoptLegacyRoots({
      nonce: 'legacy-ralph', candidates, adopted_at: '2026-07-21T00:00:00.000Z',
    });
    expect(matched.root?.children).toMatchObject([{ mode: 'ultrawork', run_id: 'uw-run' }]);

    const mismatched = createStore();
    expect(() => mismatched.adoptLegacyRoots({
      nonce: 'legacy-bad-link',
      adopted_at: '2026-07-21T00:00:00.000Z',
      candidates: [{ ...candidates[0] }, { ...candidates[1], linked_to_ralph: false }],
    })).toThrow(/mutual/i);
  });

  it('adopts the exact legacy Autopilot -> Ralph -> Ultrawork lineage', () => {
    const store = createStore();
    const adopted = store.adoptLegacyRoots({
      nonce: 'legacy-tree',
      adopted_at: '2026-07-21T00:00:00.000Z',
      candidates: [
        { mode: 'autopilot', session_id: 'session-control', run_id: 'auto', active: true },
        {
          mode: 'ralph', session_id: 'session-control', run_id: 'ralph', active: true,
          linked_ultrawork: true,
          parent: { mode: 'autopilot', session_id: 'session-control', run_id: 'auto' },
        },
        {
          mode: 'ultrawork', session_id: 'session-control', run_id: 'uw', active: true,
          linked_to_ralph: true,
          parent: { mode: 'ralph', session_id: 'session-control', run_id: 'ralph' },
        },
      ],
    });

    expect(adopted.root?.children.map((child) => `${child.parent.mode}->${child.mode}`)).toEqual([
      'autopilot->ralph',
      'ralph->ultrawork',
    ]);
  });

  it('fails closed on duplicate, cyclic, and unclaimed legacy identities', () => {
    expect(() => createStore().adoptLegacyRoots({
      nonce: 'legacy-duplicate', adopted_at: '2026-07-21T00:00:00.000Z',
      candidates: [
        { mode: 'autopilot', session_id: 'session-control', run_id: 'auto', active: true },
        { mode: 'autopilot', session_id: 'session-control', run_id: 'auto', active: true },
      ],
    })).toThrow(/duplicate/i);

    expect(() => createStore().adoptLegacyRoots({
      nonce: 'legacy-cycle', adopted_at: '2026-07-21T00:00:00.000Z',
      candidates: [
        { mode: 'autopilot', session_id: 'session-control', run_id: 'auto', active: true },
        {
          mode: 'ralph', session_id: 'session-control', run_id: 'ralph', active: true,
          linked_ultrawork: true,
          parent: { mode: 'ultrawork', session_id: 'session-control', run_id: 'uw' },
        },
        {
          mode: 'ultrawork', session_id: 'session-control', run_id: 'uw', active: true,
          linked_to_ralph: true,
          parent: { mode: 'ralph', session_id: 'session-control', run_id: 'ralph' },
        },
      ],
    })).toThrow(/cyclic|unreachable/i);

    expect(() => createStore().adoptLegacyRoots({
      nonce: 'legacy-graph', adopted_at: '2026-07-21T00:00:00.000Z',
      candidates: [
        {
          mode: 'graph', session_id: 'session-control', run_id: 'graph', active: true,
          graph_revision: GRAPH_REVISION,
        },
        {
          mode: 'team', session_id: 'team-control', run_id: 'team', active: true,
          parent: { mode: 'graph', session_id: 'session-control', run_id: 'graph' },
        },
      ],
    })).toThrow(/claim/i);
  });
});
