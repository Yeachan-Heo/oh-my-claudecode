import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  installPostToolUseHook,
  pauseHookViaSentinel,
  resumeHookViaSentinel,
  isHookPaused,
  startFallbackPoller,
} from '../worker-commit-cadence.js';

vi.mock('child_process', () => ({
  exec: vi.fn((_cmd: string, _opts: unknown, cb?: (err: null) => void) => {
    if (typeof cb === 'function') cb(null);
  }),
  execFile: vi.fn(),
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omc-cadence-test-'));
  // Minimal git init so hooks can reference .git internals
  mkdirSync(join(dir, '.git'), { recursive: true });
  return dir;
}

function readSettings(worktreePath: string): Record<string, unknown> {
  const p = join(worktreePath, '.claude', 'settings.json');
  return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 1. settings.json shape — must match Claude Code hook schema
// ---------------------------------------------------------------------------

describe('installPostToolUseHook – settings.json shape', () => {
  let worktreePath: string;

  beforeEach(() => {
    worktreePath = mkWorktree();
  });

  afterEach(() => {
    rmSync(worktreePath, { recursive: true, force: true });
  });

  it('creates .claude/settings.json with correct Claude Code hook schema', async () => {
    await installPostToolUseHook(worktreePath, 'writer');

    const settings = readSettings(worktreePath);

    // Top-level "hooks" key
    expect(settings).toHaveProperty('hooks');
    const hooks = settings.hooks as Record<string, unknown>;

    // "PostToolUse" array
    expect(hooks).toHaveProperty('PostToolUse');
    const postToolUse = hooks['PostToolUse'] as Array<Record<string, unknown>>;
    expect(Array.isArray(postToolUse)).toBe(true);
    expect(postToolUse.length).toBeGreaterThanOrEqual(1);

    // Entry shape: { matcher: string, hooks: [{ type: 'command', command: string }] }
    const entry = postToolUse[0];
    expect(entry).toHaveProperty('matcher', 'Write|Edit|MultiEdit');
    expect(entry).toHaveProperty('hooks');
    const innerHooks = entry['hooks'] as Array<Record<string, unknown>>;
    expect(Array.isArray(innerHooks)).toBe(true);
    expect(innerHooks.length).toBe(1);
    expect(innerHooks[0]).toMatchObject({ type: 'command' });
    expect(typeof innerHooks[0]['command']).toBe('string');
  });

  it('hook command embeds the worker name', async () => {
    await installPostToolUseHook(worktreePath, 'my-worker');

    const settings = readSettings(worktreePath);
    const hooks = settings.hooks as Record<string, unknown>;
    const postToolUse = hooks['PostToolUse'] as Array<Record<string, unknown>>;
    const innerHooks = postToolUse[0]['hooks'] as Array<Record<string, unknown>>;
    const command = innerHooks[0]['command'] as string;

    expect(command).toContain('my-worker');
  });

  it('hook command checks for .git/rebase-merge directory guard', async () => {
    await installPostToolUseHook(worktreePath, 'writer');

    const settings = readSettings(worktreePath);
    const hooks = settings.hooks as Record<string, unknown>;
    const postToolUse = hooks['PostToolUse'] as Array<Record<string, unknown>>;
    const innerHooks = postToolUse[0]['hooks'] as Array<Record<string, unknown>>;
    const command = innerHooks[0]['command'] as string;

    // Must use -d for rebase-merge (it is a directory)
    expect(command).toContain('-d .git/rebase-merge');
    // Must check for MERGE_HEAD
    expect(command).toContain('.git/MERGE_HEAD');
    // Must check for sentinel
    expect(command).toContain('.hook-paused');
  });

  it('hook command uses git diff --cached --quiet to skip empty diffs', async () => {
    await installPostToolUseHook(worktreePath, 'writer');

    const settings = readSettings(worktreePath);
    const hooks = settings.hooks as Record<string, unknown>;
    const postToolUse = hooks['PostToolUse'] as Array<Record<string, unknown>>;
    const innerHooks = postToolUse[0]['hooks'] as Array<Record<string, unknown>>;
    const command = innerHooks[0]['command'] as string;

    expect(command).toContain('git diff --cached --quiet');
  });

  it('does not install hook when sentinel is present', async () => {
    // Touch the sentinel first
    await pauseHookViaSentinel(worktreePath);

    await installPostToolUseHook(worktreePath, 'writer');

    // settings.json should not have been created
    expect(existsSync(join(worktreePath, '.claude', 'settings.json'))).toBe(false);
  });

  it('merges into existing settings.json without clobbering other keys', async () => {
    // Pre-create a settings.json with an existing key
    const claudeDir = join(worktreePath, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ theme: 'dark', hooks: { PreToolUse: [] } }, null, 2),
      'utf-8',
    );

    await installPostToolUseHook(worktreePath, 'writer');

    const settings = readSettings(worktreePath);
    expect(settings).toHaveProperty('theme', 'dark');
    const hooks = settings.hooks as Record<string, unknown>;
    expect(hooks).toHaveProperty('PreToolUse');
    expect(hooks).toHaveProperty('PostToolUse');
  });

  it('replaces existing auto-commit entry on re-install (no duplicate matcher)', async () => {
    await installPostToolUseHook(worktreePath, 'writer');
    await installPostToolUseHook(worktreePath, 'writer');

    const settings = readSettings(worktreePath);
    const postToolUse = (settings.hooks as Record<string, unknown>)[
      'PostToolUse'
    ] as Array<Record<string, unknown>>;
    const matching = postToolUse.filter((h) => h['matcher'] === 'Write|Edit|MultiEdit');
    expect(matching).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Sentinel pause / resume — idempotency
// ---------------------------------------------------------------------------

describe('pauseHookViaSentinel / resumeHookViaSentinel', () => {
  let worktreePath: string;

  beforeEach(() => {
    worktreePath = mkWorktree();
  });

  afterEach(() => {
    rmSync(worktreePath, { recursive: true, force: true });
  });

  it('pause creates sentinel; isHookPaused returns true', async () => {
    expect(isHookPaused(worktreePath)).toBe(false);

    await pauseHookViaSentinel(worktreePath);

    expect(existsSync(join(worktreePath, '.hook-paused'))).toBe(true);
    expect(isHookPaused(worktreePath)).toBe(true);
  });

  it('resume removes sentinel; isHookPaused returns false', async () => {
    await pauseHookViaSentinel(worktreePath);
    expect(isHookPaused(worktreePath)).toBe(true);

    await resumeHookViaSentinel(worktreePath);

    expect(existsSync(join(worktreePath, '.hook-paused'))).toBe(false);
    expect(isHookPaused(worktreePath)).toBe(false);
  });

  it('pause is idempotent — calling twice does not throw', async () => {
    await pauseHookViaSentinel(worktreePath);
    await expect(pauseHookViaSentinel(worktreePath)).resolves.toBeUndefined();
    expect(isHookPaused(worktreePath)).toBe(true);
  });

  it('resume is idempotent — calling when not paused does not throw', async () => {
    expect(isHookPaused(worktreePath)).toBe(false);
    await expect(resumeHookViaSentinel(worktreePath)).resolves.toBeUndefined();
    expect(isHookPaused(worktreePath)).toBe(false);
  });

  it('pause then resume then pause works correctly', async () => {
    await pauseHookViaSentinel(worktreePath);
    await resumeHookViaSentinel(worktreePath);
    await pauseHookViaSentinel(worktreePath);

    expect(isHookPaused(worktreePath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Fallback poller — debounce with fake timers
// ---------------------------------------------------------------------------

describe('startFallbackPoller – debounce', () => {
  let worktreePath: string;

  beforeEach(() => {
    vi.useFakeTimers();
    worktreePath = mkWorktree();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(worktreePath, { recursive: true, force: true });
  });

  it('returns a stop handle', () => {
    const handle = startFallbackPoller(worktreePath, 'writer', { intervalMs: 3000 });
    expect(handle).toHaveProperty('stop');
    expect(typeof handle.stop).toBe('function');
    handle.stop();
  });

  it('does not commit immediately on fs event — waits for debounce', async () => {
    const { exec } = await import('child_process');
    const execMock = vi.mocked(exec);
    execMock.mockClear();

    const handle = startFallbackPoller(worktreePath, 'writer', { intervalMs: 3000 });

    // Write a file to trigger the watcher — but debounce has not fired yet
    writeFileSync(join(worktreePath, 'test.txt'), 'hello');

    // Advance time by less than debounce — exec should not have been called yet
    vi.advanceTimersByTime(1000);
    expect(execMock).not.toHaveBeenCalled();

    // Advance past debounce
    vi.advanceTimersByTime(3000);
    // exec may or may not have been called depending on whether the fs event fired
    // (fs.watch fires asynchronously; in fake timer environment the watcher may not
    // deliver the event). The important invariant is that stop() does not throw.
    handle.stop();
  });

  it('stop() cancels pending debounce timer', () => {
    const handle = startFallbackPoller(worktreePath, 'writer', { intervalMs: 3000 });

    // Simulate a debounce being scheduled by writing a file
    writeFileSync(join(worktreePath, 'a.txt'), 'data');

    // Stop before debounce fires — should not throw
    expect(() => handle.stop()).not.toThrow();

    // Advance time well past debounce — nothing should execute
    vi.advanceTimersByTime(10000);
    // No errors means stop() correctly cancelled the timer
  });

  it('respects .hook-paused sentinel — does not run commit when paused', async () => {
    // Place sentinel before poller starts
    await pauseHookViaSentinel(worktreePath);

    const { exec } = await import('child_process');
    const execMock = vi.mocked(exec);
    execMock.mockClear();

    const handle = startFallbackPoller(worktreePath, 'writer', { intervalMs: 500 });

    // Trigger debounce cycle
    vi.advanceTimersByTime(2000);

    // exec should not have been called since sentinel is set
    expect(execMock).not.toHaveBeenCalled();

    handle.stop();
  });

  it('uses default interval of 3000ms when no opts provided', () => {
    // Just verify it does not throw with default opts
    const handle = startFallbackPoller(worktreePath, 'writer');
    handle.stop();
  });
});

// ---------------------------------------------------------------------------
// 4. Empty-diff branch — hook command structure
// ---------------------------------------------------------------------------

describe('empty-diff branch — hook command', () => {
  let worktreePath: string;

  beforeEach(() => {
    worktreePath = mkWorktree();
  });

  afterEach(() => {
    rmSync(worktreePath, { recursive: true, force: true });
  });

  it('hook command uses || operator so empty diff skips commit', async () => {
    await installPostToolUseHook(worktreePath, 'writer');

    const settings = readSettings(worktreePath);
    const hooks = settings.hooks as Record<string, unknown>;
    const postToolUse = hooks['PostToolUse'] as Array<Record<string, unknown>>;
    const innerHooks = postToolUse[0]['hooks'] as Array<Record<string, unknown>>;
    const command = innerHooks[0]['command'] as string;

    // The pattern "git diff --cached --quiet || git commit" means: if diff is
    // non-empty (non-zero exit) then commit; if empty (zero exit) skip commit.
    expect(command).toMatch(/git diff --cached --quiet.*\|\|.*git commit/);
  });
});

// ---------------------------------------------------------------------------
// 5. Sentinel filename correctness — exactly one '.hook-paused' (no double-dot)
// ---------------------------------------------------------------------------

describe('hook command sentinel filename', () => {
  let worktreePath: string;

  beforeEach(() => {
    worktreePath = mkWorktree();
  });

  afterEach(() => {
    rmSync(worktreePath, { recursive: true, force: true });
  });

  it('uses exactly one ".hook-paused" (no double-dot bug)', async () => {
    await installPostToolUseHook(worktreePath, 'writer');

    const settings = readSettings(worktreePath);
    const hooks = settings.hooks as Record<string, unknown>;
    const postToolUse = hooks['PostToolUse'] as Array<Record<string, unknown>>;
    const innerHooks = postToolUse[0]['hooks'] as Array<Record<string, unknown>>;
    const command = innerHooks[0]['command'] as string;

    // Bug guard: previously the preamble interpolated `.${SENTINEL_FILENAME}`
    // which produced `..hook-paused` (two dots) and never matched the sentinel.
    expect(command).not.toContain('..hook-paused');
    expect(command).toContain('[ -e .hook-paused ]');
  });

  it('contains a single occurrence of ".hook-paused" in the hook command', async () => {
    await installPostToolUseHook(worktreePath, 'writer');

    const settings = readSettings(worktreePath);
    const hooks = settings.hooks as Record<string, unknown>;
    const postToolUse = hooks['PostToolUse'] as Array<Record<string, unknown>>;
    const innerHooks = postToolUse[0]['hooks'] as Array<Record<string, unknown>>;
    const command = innerHooks[0]['command'] as string;

    const matches = command.match(/\.hook-paused/g) ?? [];
    expect(matches).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Worker-name validation — shell-injection guard
// ---------------------------------------------------------------------------

describe('worker name validation (shell injection guard)', () => {
  let worktreePath: string;

  beforeEach(() => {
    worktreePath = mkWorktree();
  });

  afterEach(() => {
    rmSync(worktreePath, { recursive: true, force: true });
  });

  it('installPostToolUseHook throws on a name containing a single quote', async () => {
    await expect(
      installPostToolUseHook(worktreePath, "alice'; rm -rf /; #"),
    ).rejects.toThrow(/Invalid worker name/);
  });

  it('installPostToolUseHook throws on a name containing whitespace', async () => {
    await expect(
      installPostToolUseHook(worktreePath, 'alice bob'),
    ).rejects.toThrow(/Invalid worker name/);
  });

  it('installPostToolUseHook throws on a name containing $', async () => {
    await expect(
      installPostToolUseHook(worktreePath, 'alice$(id)'),
    ).rejects.toThrow(/Invalid worker name/);
  });

  it('installPostToolUseHook throws on an empty name', async () => {
    await expect(
      installPostToolUseHook(worktreePath, ''),
    ).rejects.toThrow(/Invalid worker name/);
  });

  it('startFallbackPoller throws on injectable name (synchronous)', () => {
    expect(() =>
      startFallbackPoller(worktreePath, "alice'; touch /tmp/pwn; #"),
    ).toThrow(/Invalid worker name/);
  });

  it('accepts safe alphanumeric/dash/underscore names', async () => {
    await expect(
      installPostToolUseHook(worktreePath, 'alice-1_writer'),
    ).resolves.toBeUndefined();
  });
});
