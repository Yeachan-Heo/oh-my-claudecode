import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { cleanupTransientState } from '../../hooks/session-end/index.js';

describe('cleanupTransientState — session-scoped hud-stdin-cache', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'omc-session-end-cleanup-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('removes the ending session\'s hud-stdin-cache.json and prunes its empty directory', () => {
    // Simulate the tree that `writeStdinCache` leaves behind after a session.
    const sessionDir = join(tmpRoot, '.omc', 'state', 'sessions', 'session-aaa');
    mkdirSync(sessionDir, { recursive: true });
    const cacheFile = join(sessionDir, 'hud-stdin-cache.json');
    writeFileSync(cacheFile, '{}');

    const removed = cleanupTransientState(tmpRoot, 'session-aaa');

    expect(existsSync(cacheFile)).toBe(false);
    expect(existsSync(sessionDir)).toBe(false);
    // Sanity: at least one unlink + one rmdir happened.
    expect(removed).toBeGreaterThanOrEqual(2);
  });

  it('preserves the ending session\'s dir when it still has non-transient state', () => {
    const sessionDir = join(tmpRoot, '.omc', 'state', 'sessions', 'session-bbb');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'hud-stdin-cache.json'), '{}');
    // A state file that should NOT be cleaned (only transient files are targeted).
    const keep = join(sessionDir, 'ralph-state.json');
    writeFileSync(keep, '{"active":true}');

    cleanupTransientState(tmpRoot, 'session-bbb');

    expect(existsSync(join(sessionDir, 'hud-stdin-cache.json'))).toBe(false);
    expect(existsSync(keep)).toBe(true);
    // Directory must remain because `ralph-state.json` is still there.
    expect(existsSync(sessionDir)).toBe(true);
  });

  it('still removes the legacy top-level hud-stdin-cache.json', () => {
    // Regression: don't drop the old flat-path cleanup path used by session-less callers.
    const stateDir = join(tmpRoot, '.omc', 'state');
    mkdirSync(stateDir, { recursive: true });
    const legacy = join(stateDir, 'hud-stdin-cache.json');
    writeFileSync(legacy, '{}');

    cleanupTransientState(tmpRoot);

    expect(existsSync(legacy)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Regression for the follow-up Codex P2: one session ending must not touch
  // another concurrent session's HUD cache or prune its directory.
  // ---------------------------------------------------------------------------

  it('does not delete another running session\'s hud-stdin-cache.json', () => {
    const ending = join(tmpRoot, '.omc', 'state', 'sessions', 'session-ending');
    const other = join(tmpRoot, '.omc', 'state', 'sessions', 'session-other');
    mkdirSync(ending, { recursive: true });
    mkdirSync(other, { recursive: true });
    writeFileSync(join(ending, 'hud-stdin-cache.json'), '{}');
    writeFileSync(join(other, 'hud-stdin-cache.json'), '{"running":true}');

    cleanupTransientState(tmpRoot, 'session-ending');

    // Ending session's cache is gone, its dir pruned.
    expect(existsSync(join(ending, 'hud-stdin-cache.json'))).toBe(false);
    expect(existsSync(ending)).toBe(false);

    // The other session's cache and dir must be left untouched.
    expect(existsSync(join(other, 'hud-stdin-cache.json'))).toBe(true);
    expect(existsSync(other)).toBe(true);
  });

  it('still purges cancel-signal/stop-breaker across all session dirs', () => {
    // These patterns are intentionally cross-session-safe because they are
    // short-lived markers, not live per-session state. Guard against a
    // future refactor accidentally scoping them too narrowly.
    const ending = join(tmpRoot, '.omc', 'state', 'sessions', 'session-ending');
    const other = join(tmpRoot, '.omc', 'state', 'sessions', 'session-other');
    mkdirSync(ending, { recursive: true });
    mkdirSync(other, { recursive: true });
    writeFileSync(join(ending, 'cancel-signal-state.json'), '{}');
    writeFileSync(join(other, 'autopilot-stop-breaker.json'), '{}');

    cleanupTransientState(tmpRoot, 'session-ending');

    expect(existsSync(join(ending, 'cancel-signal-state.json'))).toBe(false);
    expect(existsSync(join(other, 'autopilot-stop-breaker.json'))).toBe(false);
  });

  it('is a no-op on other sessions\' HUD cache when no endingSessionId is provided (legacy compat)', () => {
    // Legacy callers that omit endingSessionId should not widen the blast
    // radius. HUD cache may only disappear when the caller identifies the
    // ending session explicitly.
    const other = join(tmpRoot, '.omc', 'state', 'sessions', 'session-other');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'hud-stdin-cache.json'), '{"running":true}');

    cleanupTransientState(tmpRoot);

    expect(existsSync(join(other, 'hud-stdin-cache.json'))).toBe(true);
    expect(existsSync(other)).toBe(true);
  });
});
