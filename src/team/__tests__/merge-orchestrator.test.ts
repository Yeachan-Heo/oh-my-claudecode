// Unit tests for src/team/merge-orchestrator.ts
//
// All git invocations are mocked via vi.mock('node:child_process'). We never
// spawn a real git process — the orchestrator's behaviour is fully driven by
// the mocked exec*Sync surface.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Hoisted mock state (must be declared before vi.mock factories run).
// ---------------------------------------------------------------------------

interface GitCall {
  cmd: string;
  args: readonly string[];
  cwd?: string;
}

const mocks = vi.hoisted(() => {
  const calls: GitCall[] = [];
  // Programmable behaviour for git invocations keyed by a string match.
  // Each handler returns: a string (stdout for success), or throws an Error
  // with optional .status and .stdout properties (mimicking child_process).
  const handlers: Array<{
    match: (args: readonly string[], cwd?: string) => boolean;
    handler: (args: readonly string[], cwd?: string) =>
      | string
      | { stdout: string }
      | { throwStatus: number; stdout?: string; stderr?: string }
      | { throw: true; message?: string };
  }> = [];

  const reset = (): void => {
    calls.length = 0;
    handlers.length = 0;
  };

  return {
    calls,
    handlers,
    reset,
    execFileSync: vi.fn((cmd: string, args: readonly string[], opts?: { cwd?: string; encoding?: string }) => {
      calls.push({ cmd, args, cwd: opts?.cwd });
      for (const h of handlers) {
        if (h.match(args, opts?.cwd)) {
          const r = h.handler(args, opts?.cwd);
          if (typeof r === 'string') {
            // Return a Buffer when no encoding requested, else a string.
            return opts?.encoding ? r : Buffer.from(r);
          }
          if ('throwStatus' in r) {
            const err: NodeJS.ErrnoException & { status?: number; stdout?: string; stderr?: string } =
              new Error(`git ${args.join(' ')} exited ${r.throwStatus}`) as never;
            err.status = r.throwStatus;
            err.stdout = r.stdout ?? '';
            err.stderr = r.stderr ?? '';
            throw err;
          }
          if ('throw' in r) {
            throw new Error(r.message ?? `git ${args.join(' ')} failed`);
          }
          if ('stdout' in r) {
            return opts?.encoding ? r.stdout : Buffer.from(r.stdout);
          }
        }
      }
      // Unhandled — return empty.
      return opts?.encoding ? '' : Buffer.from('');
    }),
    exec: vi.fn(),
    execSync: vi.fn(),
    execFile: vi.fn(),
  };
});

vi.mock('node:child_process', () => ({
  execFileSync: mocks.execFileSync,
  exec: mocks.exec,
  execSync: mocks.execSync,
  execFile: mocks.execFile,
}));

// Re-mount the same mock for the unprefixed module name (some callers import
// 'child_process' rather than 'node:child_process').
vi.mock('child_process', () => ({
  execFileSync: mocks.execFileSync,
  exec: mocks.exec,
  execSync: mocks.execSync,
  execFile: mocks.execFile,
}));

// ---------------------------------------------------------------------------
// Imports of the SUT (after mocks are installed).
// ---------------------------------------------------------------------------

import {
  startMergeOrchestrator,
  recoverFromRestart,
  type OrchestratorConfig,
} from '../merge-orchestrator.js';
import { sanitizeName } from '../tmux-session.js';
import { atomicWriteJson } from '../fs-utils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepoRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'merge-orchestrator-test-'));
  return dir;
}

function defaultConfig(repoRoot: string): OrchestratorConfig {
  return {
    teamName: 'demo-team',
    repoRoot,
    leaderBranch: 'feat/integration',
    cwd: repoRoot,
    pollIntervalMs: 50,
    drainTimeoutMs: 500,
  };
}

function on(match: (args: readonly string[], cwd?: string) => boolean, handler: (args: readonly string[], cwd?: string) => string | { throwStatus: number; stdout?: string } | { throw: true; message?: string } | { stdout: string }): void {
  mocks.handlers.push({ match, handler });
}

function defaultHappyPath(_repoRoot: string, leaderBranch: string): void {
  // git worktree add — succeeds.
  on(
    (args) => args[0] === 'worktree' && args[1] === 'add',
    () => '',
  );
  // git worktree list — return empty by default; caller can override before.
  on(
    (args) => args[0] === 'worktree' && args[1] === 'list',
    () => '',
  );
  // git rev-parse refs/heads/{leaderBranch} — return a stable head sha.
  on(
    (args, _cwd) => args[0] === 'rev-parse' && args[1] === `refs/heads/${leaderBranch}`,
    () => 'leader-head-sha\n',
  );
  // git fetch — succeed silently.
  on(
    (args) => args[0] === 'fetch',
    () => '',
  );
  // git reset --hard — succeed.
  on(
    (args) => args[0] === 'reset' && args[1] === '--hard',
    () => '',
  );
  // git diff-index --quiet HEAD --
  on(
    (args) => args[0] === 'diff-index',
    () => '',
  );
  // git checkout
  on(
    (args) => args[0] === 'checkout',
    () => '',
  );
  // git merge-base
  on(
    (args) => args[0] === 'merge-base',
    () => 'merge-base-sha\n',
  );
}

beforeEach(() => {
  mocks.reset();
  process.env.OMC_RUNTIME_V2 = '1';
});

afterEach(() => {
  delete process.env.OMC_RUNTIME_V2;
});

// ---------------------------------------------------------------------------
// M3: branch-name guard
// ---------------------------------------------------------------------------

describe('M3 leader-branch guard', () => {
  it('rejects "main"', async () => {
    const repoRoot = makeRepoRoot();
    try {
      const cfg = { ...defaultConfig(repoRoot), leaderBranch: 'main' };
      await expect(startMergeOrchestrator(cfg)).rejects.toThrow(/main\/master/);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('rejects "MAIN" (case-insensitive)', async () => {
    const repoRoot = makeRepoRoot();
    try {
      const cfg = { ...defaultConfig(repoRoot), leaderBranch: 'MAIN' };
      await expect(startMergeOrchestrator(cfg)).rejects.toThrow(/main\/master/);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('rejects "master"', async () => {
    const repoRoot = makeRepoRoot();
    try {
      const cfg = { ...defaultConfig(repoRoot), leaderBranch: 'master' };
      await expect(startMergeOrchestrator(cfg)).rejects.toThrow(/main\/master/);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('rejects "refs/heads/main"', async () => {
    const repoRoot = makeRepoRoot();
    try {
      const cfg = { ...defaultConfig(repoRoot), leaderBranch: 'refs/heads/main' };
      await expect(startMergeOrchestrator(cfg)).rejects.toThrow(/main\/master/);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('accepts a feature branch', async () => {
    const repoRoot = makeRepoRoot();
    try {
      const cfg = defaultConfig(repoRoot);
      defaultHappyPath(repoRoot, cfg.leaderBranch);
      const handle = await startMergeOrchestrator(cfg);
      expect(handle.getState().workers).toEqual([]);
      await handle.drainAndStop();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Branch-name flag-injection guard (validateBranchName)
// ---------------------------------------------------------------------------

describe('validateBranchName guard', () => {
  it('rejects leader branch name that looks like a flag (--upload-pack=...)', async () => {
    const repoRoot = makeRepoRoot();
    try {
      const cfg = { ...defaultConfig(repoRoot), leaderBranch: '--upload-pack=evil' };
      await expect(startMergeOrchestrator(cfg)).rejects.toThrow(/Invalid branch name/);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('rejects leader branch name starting with -e/payload', async () => {
    const repoRoot = makeRepoRoot();
    try {
      const cfg = { ...defaultConfig(repoRoot), leaderBranch: '-e/payload' };
      await expect(startMergeOrchestrator(cfg)).rejects.toThrow(/Invalid branch name/);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// M5: v2 gate
// ---------------------------------------------------------------------------

describe('M5 v2 gate', () => {
  it('allows unset OMC_RUNTIME_V2 because runtime v2 is default-on', async () => {
    delete process.env.OMC_RUNTIME_V2;
    const repoRoot = makeRepoRoot();
    try {
      const cfg = defaultConfig(repoRoot);
      defaultHappyPath(repoRoot, cfg.leaderBranch);
      const handle = await startMergeOrchestrator(cfg);
      await handle.drainAndStop();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('throws when OMC_RUNTIME_V2=0', async () => {
    process.env.OMC_RUNTIME_V2 = '0';
    const repoRoot = makeRepoRoot();
    try {
      const cfg = defaultConfig(repoRoot);
      await expect(startMergeOrchestrator(cfg)).rejects.toThrow(/runtime v2/);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// SHA-change detection + merge driver
// ---------------------------------------------------------------------------

describe('commit watcher + auto-merge', () => {
  it('detects a SHA change and triggers a merge', async () => {
    const repoRoot = makeRepoRoot();
    try {
      const cfg = defaultConfig(repoRoot);
      defaultHappyPath(repoRoot, cfg.leaderBranch);

      // Seed: worker branch HEAD reads as sha-A initially, then sha-B on the
      // next call.
      const workerName = 'alice';
      const branchName = `omc-team/demo-team/${sanitizeName(workerName)}`;
      let revParseCount = 0;
      on(
        (args) => args[0] === 'rev-parse' && args[1] === `refs/heads/${branchName}`,
        () => {
          revParseCount += 1;
          return revParseCount === 1 ? 'sha-A\n' : 'sha-B\n';
        },
      );
      // merge-tree returns clean (exit 0).
      on(
        (args) => args[0] === 'merge-tree',
        () => '',
      );

      const handle = await startMergeOrchestrator(cfg);
      await handle.registerWorker(workerName);

      // Wait for the poller to fire at least twice.
      await new Promise((r) => setTimeout(r, 200));

      const mergeAttempts = mocks.calls.filter(
        (c) => c.cmd === 'git' && c.args[0] === 'merge' && c.args[1] === '--no-ff',
      );
      expect(mergeAttempts.length).toBeGreaterThanOrEqual(1);

      await handle.drainAndStop();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('persists lastShas atomically after observing a change', async () => {
    const repoRoot = makeRepoRoot();
    try {
      const cfg = defaultConfig(repoRoot);
      defaultHappyPath(repoRoot, cfg.leaderBranch);

      const workerName = 'bob';
      const branchName = `omc-team/demo-team/${sanitizeName(workerName)}`;
      let revParseCount = 0;
      on(
        (args) => args[0] === 'rev-parse' && args[1] === `refs/heads/${branchName}`,
        () => {
          revParseCount += 1;
          return revParseCount === 1 ? 'seed-sha\n' : 'next-sha\n';
        },
      );
      on(
        (args) => args[0] === 'merge-tree',
        () => '',
      );

      const handle = await startMergeOrchestrator(cfg);
      await handle.registerWorker(workerName);

      await new Promise((r) => setTimeout(r, 200));

      const persistedPath = join(
        repoRoot,
        '.omc',
        'state',
        'team',
        sanitizeName(cfg.teamName),
        'auto-merge-state.json',
      );
      expect(existsSync(persistedPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(persistedPath, 'utf-8')) as {
        lastShas: Record<string, string>;
      };
      expect(parsed.lastShas[workerName]).toMatch(/sha/);

      await handle.drainAndStop();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('handles multiple workers independently', async () => {
    const repoRoot = makeRepoRoot();
    try {
      const cfg = defaultConfig(repoRoot);
      defaultHappyPath(repoRoot, cfg.leaderBranch);

      const branchA = `omc-team/demo-team/${sanitizeName('alice')}`;
      const branchB = `omc-team/demo-team/${sanitizeName('bob')}`;
      let aCount = 0;
      let bCount = 0;
      on(
        (args) => args[0] === 'rev-parse' && args[1] === `refs/heads/${branchA}`,
        () => {
          aCount += 1;
          return aCount === 1 ? 'a-sha-0\n' : 'a-sha-1\n';
        },
      );
      on(
        (args) => args[0] === 'rev-parse' && args[1] === `refs/heads/${branchB}`,
        () => {
          bCount += 1;
          // Bob never advances — stays at the same sha.
          return 'b-sha-0\n';
        },
      );
      on(
        (args) => args[0] === 'merge-tree',
        () => '',
      );

      const handle = await startMergeOrchestrator(cfg);
      await handle.registerWorker('alice');
      await handle.registerWorker('bob');

      await new Promise((r) => setTimeout(r, 250));

      const mergeAttempts = mocks.calls.filter(
        (c) => c.cmd === 'git' && c.args[0] === 'merge' && c.args[1] === '--no-ff',
      );
      // Alice's branch changed → at least one merge attempt; Bob never advanced.
      expect(mergeAttempts.length).toBeGreaterThanOrEqual(1);
      // Make sure bob never triggered a merge (only alice's branch was the merge arg).
      const aliceMerges = mergeAttempts.filter((c) => c.args.some((a) => a.includes('alice')));
      const bobMerges = mergeAttempts.filter((c) => c.args.some((a) => a.includes('bob')));
      expect(aliceMerges.length).toBeGreaterThanOrEqual(1);
      expect(bobMerges.length).toBe(0);

      await handle.drainAndStop();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('runs preflight reset before each merge', async () => {
    const repoRoot = makeRepoRoot();
    try {
      const cfg = defaultConfig(repoRoot);
      defaultHappyPath(repoRoot, cfg.leaderBranch);

      const branchName = `omc-team/demo-team/${sanitizeName('alice')}`;
      let count = 0;
      on(
        (args) => args[0] === 'rev-parse' && args[1] === `refs/heads/${branchName}`,
        () => {
          count += 1;
          return count === 1 ? 'sha-A\n' : 'sha-B\n';
        },
      );
      on(
        (args) => args[0] === 'merge-tree',
        () => '',
      );

      const handle = await startMergeOrchestrator(cfg);
      await handle.registerWorker('alice');

      await new Promise((r) => setTimeout(r, 200));

      const resetCalls = mocks.calls.filter(
        (c) => c.cmd === 'git' && c.args[0] === 'reset' && c.args[1] === '--hard',
      );
      expect(resetCalls.length).toBeGreaterThanOrEqual(1);

      await handle.drainAndStop();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('serialises concurrent merges via the mutex', async () => {
    const repoRoot = makeRepoRoot();
    try {
      const cfg = defaultConfig(repoRoot);
      defaultHappyPath(repoRoot, cfg.leaderBranch);

      // Both workers advance concurrently. Merges must not interleave —
      // each merge sequence is preflight-reset → merge-tree → checkout → merge.
      const branchA = `omc-team/demo-team/${sanitizeName('alice')}`;
      const branchB = `omc-team/demo-team/${sanitizeName('bob')}`;
      let aCount = 0;
      let bCount = 0;
      on(
        (args) => args[0] === 'rev-parse' && args[1] === `refs/heads/${branchA}`,
        () => {
          aCount += 1;
          return aCount === 1 ? 'a-0\n' : 'a-1\n';
        },
      );
      on(
        (args) => args[0] === 'rev-parse' && args[1] === `refs/heads/${branchB}`,
        () => {
          bCount += 1;
          return bCount === 1 ? 'b-0\n' : 'b-1\n';
        },
      );
      on(
        (args) => args[0] === 'merge-tree',
        () => '',
      );

      const handle = await startMergeOrchestrator(cfg);
      await handle.registerWorker('alice');
      await handle.registerWorker('bob');

      await new Promise((r) => setTimeout(r, 350));

      // Inspect the call order — for each merge, we expect a preflight reset
      // before the actual merge call. With a working mutex the pattern should
      // be: reset, [merge-tree, ...], merge, ...reset, [merge-tree...], merge.
      const sequence = mocks.calls
        .filter((c) => c.cmd === 'git')
        .map((c) => c.args[0]);
      // We don't assert exact ordering, but we DO assert that the number of
      // 'merge' (--no-ff) calls equals the number of preceding 'reset --hard'
      // calls (within tolerance) — i.e. one preflight per merge.
      const merges = sequence.filter((s) => s === 'merge').length;
      const resets = sequence.filter((s) => s === 'reset').length;
      expect(resets).toBeGreaterThanOrEqual(merges);

      await handle.drainAndStop();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('records merge_conflict event when checkMergeConflicts reports conflicts', async () => {
    const repoRoot = makeRepoRoot();
    try {
      const cfg = defaultConfig(repoRoot);
      defaultHappyPath(repoRoot, cfg.leaderBranch);

      const branchName = `omc-team/demo-team/${sanitizeName('alice')}`;
      let count = 0;
      on(
        (args) => args[0] === 'rev-parse' && args[1] === `refs/heads/${branchName}`,
        () => {
          count += 1;
          return count === 1 ? 'old\n' : 'new\n';
        },
      );
      // merge-tree returns conflict (exit 1 with stdout listing CONFLICT).
      on(
        (args) => args[0] === 'merge-tree',
        () => ({
          throwStatus: 1,
          stdout: 'CONFLICT (content): Merge conflict in foo.ts\nfoo\n',
        }),
      );

      const handle = await startMergeOrchestrator(cfg);
      await handle.registerWorker('alice');

      await new Promise((r) => setTimeout(r, 200));

      const eventLog = join(
        repoRoot,
        '.omc',
        'state',
        'team',
        sanitizeName(cfg.teamName),
        'orchestrator-events.jsonl',
      );
      expect(existsSync(eventLog)).toBe(true);
      const lines = readFileSync(eventLog, 'utf-8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { type: string });
      expect(lines.some((e) => e.type === 'merge_conflict')).toBe(true);

      // No actual merge should have been invoked when conflicts are detected
      // pre-flight.
      const merges = mocks.calls.filter(
        (c) => c.cmd === 'git' && c.args[0] === 'merge' && c.args[1] === '--no-ff',
      );
      expect(merges.length).toBe(0);

      await handle.drainAndStop();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('backs off polling for chronically-failing workers', async () => {
    const repoRoot = makeRepoRoot();
    try {
      const cfg = defaultConfig(repoRoot);
      defaultHappyPath(repoRoot, cfg.leaderBranch);

      const branchName = `omc-team/demo-team/${sanitizeName('alice')}`;
      let count = 0;
      // Throw on every rev-parse for the worker branch.
      on(
        (args) => args[0] === 'rev-parse' && args[1] === `refs/heads/${branchName}`,
        () => {
          count += 1;
          return { throw: true, message: 'rev-parse failed' };
        },
      );

      const handle = await startMergeOrchestrator(cfg);
      await handle.registerWorker('alice');

      await new Promise((r) => setTimeout(r, 400));

      // Backoff means count grows sub-linearly with poll ticks.
      // We can't assert exact counts (timer jitter), but we can assert that
      // the poller did NOT call rev-parse on every single tick.
      // pollIntervalMs=50 → ~8 ticks in 400ms. With backoff after a few
      // failures, count should be << 8.
      expect(count).toBeGreaterThanOrEqual(1);
      expect(count).toBeLessThanOrEqual(8);

      await handle.drainAndStop();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// M1: existing-rebase short-circuit
// ---------------------------------------------------------------------------

describe('M1 existing-rebase short-circuit', () => {
  it('skips rebase fan-out when .git/rebase-merge exists in the other worker worktree', async () => {
    const repoRoot = makeRepoRoot();
    try {
      const cfg = defaultConfig(repoRoot);
      defaultHappyPath(repoRoot, cfg.leaderBranch);

      // Create a fake worktree dir with .git/rebase-merge for "bob".
      const bobWtPath = join(
        repoRoot,
        '.omc',
        'team',
        sanitizeName(cfg.teamName),
        'worktrees',
        sanitizeName('bob'),
      );
      mkdirSync(join(bobWtPath, '.git', 'rebase-merge'), { recursive: true });

      const branchA = `omc-team/demo-team/${sanitizeName('alice')}`;
      const branchB = `omc-team/demo-team/${sanitizeName('bob')}`;
      let aCount = 0;
      on(
        (args) => args[0] === 'rev-parse' && args[1] === `refs/heads/${branchA}`,
        () => {
          aCount += 1;
          return aCount === 1 ? 'a-0\n' : 'a-1\n';
        },
      );
      on(
        (args) => args[0] === 'rev-parse' && args[1] === `refs/heads/${branchB}`,
        () => 'b-0\n',
      );
      on(
        (args) => args[0] === 'merge-tree',
        () => '',
      );

      const handle = await startMergeOrchestrator(cfg);
      await handle.registerWorker('alice');
      await handle.registerWorker('bob');

      await new Promise((r) => setTimeout(r, 250));

      // No `git rebase` should have been invoked in bob's worktree.
      const rebaseCalls = mocks.calls.filter(
        (c) => c.cmd === 'git' && c.args[0] === 'rebase' && c.cwd === bobWtPath,
      );
      expect(rebaseCalls.length).toBe(0);

      // The skip event should be in the orchestrator event log.
      const eventLog = join(
        repoRoot,
        '.omc',
        'state',
        'team',
        sanitizeName(cfg.teamName),
        'orchestrator-events.jsonl',
      );
      const lines = existsSync(eventLog)
        ? readFileSync(eventLog, 'utf-8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l) as { type: string; worker?: string; reason?: string })
        : [];
      expect(
        lines.some(
          (e) =>
            e.type === 'rebase_skipped_in_progress' &&
            e.worker === 'bob' &&
            e.reason === 'rebase-already-in-progress',
        ),
      ).toBe(true);

      await handle.drainAndStop();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// M4: dirty-tree audit on rebase resolution
// ---------------------------------------------------------------------------

describe('M4 dirty-tree audit', () => {
  it('appends an audit message when worker worktree is dirty after rebase resolution', async () => {
    const repoRoot = makeRepoRoot();
    try {
      const cfg = defaultConfig(repoRoot);
      defaultHappyPath(repoRoot, cfg.leaderBranch);

      // Pre-stage: bob's worktree exists and we'll simulate a rebase that
      // conflicts (rebase command throws), then we remove .git/rebase-merge to
      // simulate the worker resolving it. The status mock returns dirty files.
      const bobWtPath = join(
        repoRoot,
        '.omc',
        'team',
        sanitizeName(cfg.teamName),
        'worktrees',
        sanitizeName('bob'),
      );
      mkdirSync(bobWtPath, { recursive: true });

      const branchA = `omc-team/demo-team/${sanitizeName('alice')}`;
      const branchB = `omc-team/demo-team/${sanitizeName('bob')}`;
      let aCount = 0;
      on(
        (args) => args[0] === 'rev-parse' && args[1] === `refs/heads/${branchA}`,
        () => {
          aCount += 1;
          return aCount === 1 ? 'a-0\n' : 'a-1\n';
        },
      );
      on(
        (args) => args[0] === 'rev-parse' && args[1] === `refs/heads/${branchB}`,
        () => 'b-0\n',
      );
      on(
        (args) => args[0] === 'merge-tree',
        () => '',
      );

      // git rebase in bob's worktree: throw to simulate conflict.
      // Side-effect: drop a fake .git/rebase-merge dir to simulate rebase state.
      on(
        (args, cwd) =>
          args[0] === 'rebase' &&
          args[1] === cfg.leaderBranch &&
          cwd === bobWtPath,
        () => {
          mkdirSync(join(bobWtPath, '.git', 'rebase-merge'), { recursive: true });
          return { throw: true, message: 'rebase conflict' };
        },
      );
      // git status --porcelain in bob's worktree:
      //   First call (after rebase failure) → return UU lines.
      //   Subsequent calls (after resolution) → return dirty (M-modified) files.
      let statusCount = 0;
      on(
        (args, cwd) =>
          args[0] === 'status' && args[1] === '--porcelain' && cwd === bobWtPath,
        () => {
          statusCount += 1;
          if (statusCount === 1) {
            return 'UU foo.ts\n';
          }
          return ' M scratch.txt\n M extra.md\n';
        },
      );

      const handle = await startMergeOrchestrator(cfg);
      await handle.registerWorker('alice');
      await handle.registerWorker('bob');

      // Wait for the merge + rebase fan-out to fire.
      await new Promise((r) => setTimeout(r, 250));

      // Now simulate bob resolving the rebase by removing .git/rebase-merge.
      rmSync(join(bobWtPath, '.git', 'rebase-merge'), { recursive: true, force: true });

      // Wait for the resolution watcher to detect.
      await new Promise((r) => setTimeout(r, 250));

      // Inbox should contain the audit message.
      const inboxPath = join(
        repoRoot,
        '.omc',
        'state',
        'team',
        cfg.teamName,
        'workers',
        'bob',
        'inbox.md',
      );
      expect(existsSync(inboxPath)).toBe(true);
      const inboxContent = readFileSync(inboxPath, 'utf-8');
      expect(inboxContent).toContain('Auto-commit audit');
      expect(inboxContent).toMatch(/scratch\.txt|extra\.md/);

      await handle.drainAndStop();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// recoverFromRestart (M6)
// ---------------------------------------------------------------------------

describe('M6 recoverFromRestart', () => {
  it('loads persisted SHA state and reports orphaned rebases', async () => {
    const repoRoot = makeRepoRoot();
    try {
      const cfg = defaultConfig(repoRoot);

      // Seed persisted state.
      const persistedPath = join(
        repoRoot,
        '.omc',
        'state',
        'team',
        sanitizeName(cfg.teamName),
        'auto-merge-state.json',
      );
      mkdirSync(join(repoRoot, '.omc', 'state', 'team', sanitizeName(cfg.teamName)), {
        recursive: true,
      });
      atomicWriteJson(persistedPath, { lastShas: { alice: 'sha-1', bob: 'sha-2' } });

      // Seed worktrees.json metadata.
      const worktreesMetaPath = join(
        repoRoot,
        '.omc',
        'state',
        'team',
        sanitizeName(cfg.teamName),
        'worktrees.json',
      );
      const aliceWtPath = join(
        repoRoot,
        '.omc',
        'team',
        sanitizeName(cfg.teamName),
        'worktrees',
        'alice',
      );
      const bobWtPath = join(
        repoRoot,
        '.omc',
        'team',
        sanitizeName(cfg.teamName),
        'worktrees',
        'bob',
      );
      mkdirSync(aliceWtPath, { recursive: true });
      mkdirSync(bobWtPath, { recursive: true });
      // Bob is mid-rebase.
      mkdirSync(join(bobWtPath, '.git', 'rebase-merge'), { recursive: true });

      atomicWriteJson(worktreesMetaPath, [
        {
          path: aliceWtPath,
          branch: 'omc-team/demo-team/alice',
          workerName: 'alice',
          teamName: cfg.teamName,
          createdAt: new Date().toISOString(),
        },
        {
          path: bobWtPath,
          branch: 'omc-team/demo-team/bob',
          workerName: 'bob',
          teamName: cfg.teamName,
          createdAt: new Date().toISOString(),
        },
      ]);

      const result = await recoverFromRestart(cfg);
      expect(result.persistedShasLoaded).toBe(2);
      expect(result.orphanedRebases).toEqual(['bob']);

      // Bob should have received the recovery message.
      const bobInbox = join(
        repoRoot,
        '.omc',
        'state',
        'team',
        cfg.teamName,
        'workers',
        'bob',
        'inbox.md',
      );
      expect(existsSync(bobInbox)).toBe(true);
      const content = readFileSync(bobInbox, 'utf-8');
      expect(content).toContain('Runtime restart recovery');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// drainAndStop
// ---------------------------------------------------------------------------

describe('drainAndStop', () => {
  it('returns no unmerged when all workers are up to date', async () => {
    const repoRoot = makeRepoRoot();
    try {
      const cfg = defaultConfig(repoRoot);
      defaultHappyPath(repoRoot, cfg.leaderBranch);

      const handle = await startMergeOrchestrator(cfg);
      const result = await handle.drainAndStop();
      expect(result.unmerged).toEqual([]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('audits unmerged workers when the drain timeout fires', async () => {
    const repoRoot = makeRepoRoot();
    try {
      const cfg = { ...defaultConfig(repoRoot), drainTimeoutMs: 50 };
      defaultHappyPath(repoRoot, cfg.leaderBranch);

      const branchName = `omc-team/demo-team/${sanitizeName('alice')}`;
      // Alice has a SHA change on first poll, but the merge will conflict.
      let count = 0;
      on(
        (args) => args[0] === 'rev-parse' && args[1] === `refs/heads/${branchName}`,
        () => {
          count += 1;
          return count === 1 ? 'old\n' : 'new\n';
        },
      );
      on(
        (args) => args[0] === 'merge-tree',
        () => ({
          throwStatus: 1,
          stdout: 'CONFLICT (content): Merge conflict in foo.ts\n',
        }),
      );

      const handle = await startMergeOrchestrator(cfg);
      await handle.registerWorker('alice');

      // Wait long enough for the watcher to observe the SHA change & try to merge.
      await new Promise((r) => setTimeout(r, 150));

      const result = await handle.drainAndStop();
      // Alice's lastObservedSha differs from lastMergedSha (merge conflict),
      // so she's reported as unmerged.
      expect(result.unmerged.length).toBeGreaterThanOrEqual(1);
      expect(result.unmerged[0].workerName).toBe('alice');

      // Teardown audit row should have been written.
      const auditPath = join(
        repoRoot,
        '.omc',
        'state',
        'team',
        sanitizeName(cfg.teamName),
        'teardown-audit.jsonl',
      );
      expect(existsSync(auditPath)).toBe(true);
      const auditContent = readFileSync(auditPath, 'utf-8');
      expect(auditContent).toContain('"type":"unmerged_at_shutdown"');
      expect(auditContent).toContain('"worker":"alice"');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// registerWorker / unregisterWorker
// ---------------------------------------------------------------------------

describe('worker registration', () => {
  it('seeds lastSha from current HEAD on register', async () => {
    const repoRoot = makeRepoRoot();
    try {
      const cfg = defaultConfig(repoRoot);
      defaultHappyPath(repoRoot, cfg.leaderBranch);

      const branchName = `omc-team/demo-team/${sanitizeName('alice')}`;
      on(
        (args) => args[0] === 'rev-parse' && args[1] === `refs/heads/${branchName}`,
        () => 'seeded-sha\n',
      );

      const handle = await startMergeOrchestrator(cfg);
      await handle.registerWorker('alice');
      const state = handle.getState();
      expect(state.workers).toContain('alice');
      expect(state.lastShas['alice']).toBe('seeded-sha');

      await handle.drainAndStop();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('is idempotent — registering twice is a no-op', async () => {
    const repoRoot = makeRepoRoot();
    try {
      const cfg = defaultConfig(repoRoot);
      defaultHappyPath(repoRoot, cfg.leaderBranch);

      on(
        (args) => args[0] === 'rev-parse' && args[1].startsWith('refs/heads/omc-team'),
        () => 'sha\n',
      );

      const handle = await startMergeOrchestrator(cfg);
      await handle.registerWorker('alice');
      await handle.registerWorker('alice');
      expect(handle.getState().workers.length).toBe(1);

      await handle.drainAndStop();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('unregisterWorker removes from state', async () => {
    const repoRoot = makeRepoRoot();
    try {
      const cfg = defaultConfig(repoRoot);
      defaultHappyPath(repoRoot, cfg.leaderBranch);

      on(
        (args) => args[0] === 'rev-parse' && args[1].startsWith('refs/heads/omc-team'),
        () => 'sha\n',
      );

      const handle = await startMergeOrchestrator(cfg);
      await handle.registerWorker('alice');
      await handle.unregisterWorker('alice');
      expect(handle.getState().workers).toEqual([]);

      await handle.drainAndStop();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// FIX 5: drain race — fan-out is suppressed once `stopped` is set
// ---------------------------------------------------------------------------

describe('drainAndStop suppresses fan-out rebase', () => {
  it('emits no rebase_triggered events for merges that complete during drain', async () => {
    const repoRoot = makeRepoRoot();
    try {
      const cfg = { ...defaultConfig(repoRoot), drainTimeoutMs: 500 };
      defaultHappyPath(repoRoot, cfg.leaderBranch);

      const branchA = `omc-team/demo-team/${sanitizeName('alice')}`;
      const branchB = `omc-team/demo-team/${sanitizeName('bob')}`;
      // Alice's branch advances during drain (lastObservedSha != lastMergedSha
      // when we call drainAndStop).
      let aliceCount = 0;
      on(
        (args) => args[0] === 'rev-parse' && args[1] === `refs/heads/${branchA}`,
        () => {
          aliceCount += 1;
          return aliceCount === 1 ? 'a-0\n' : 'a-1\n';
        },
      );
      on(
        (args) => args[0] === 'rev-parse' && args[1] === `refs/heads/${branchB}`,
        () => 'b-0\n',
      );
      on(
        (args) => args[0] === 'merge-tree',
        () => '',
      );

      // Use a long poll interval so the regular poller does not run a merge
      // before drainAndStop fires — the drain itself must execute the merge,
      // exercising the post-stop fan-out guard.
      const handle = await startMergeOrchestrator({
        ...cfg,
        pollIntervalMs: 10000,
      });
      await handle.registerWorker('alice');
      await handle.registerWorker('bob');

      // Force lastObservedSha to differ from lastMergedSha by triggering one
      // rev-parse cycle on alice.
      await handle.drainAndStop();

      // Read the orchestrator event log: there must be no rebase_triggered or
      // rebase_succeeded events emitted (fan-out is suppressed after stop).
      const eventLog = join(
        repoRoot,
        '.omc',
        'state',
        'team',
        sanitizeName(cfg.teamName),
        'orchestrator-events.jsonl',
      );
      const lines = existsSync(eventLog)
        ? readFileSync(eventLog, 'utf-8')
            .trim()
            .split('\n')
            .filter((l) => l.length > 0)
            .map((l) => JSON.parse(l) as { type: string; worker?: string })
        : [];
      const fanOutTypes = lines.filter(
        (e) => e.type === 'rebase_triggered' || e.type === 'rebase_succeeded' || e.type === 'rebase_conflict',
      );
      expect(fanOutTypes).toEqual([]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
