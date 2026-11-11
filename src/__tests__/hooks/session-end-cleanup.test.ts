import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { cleanupTransientState } from '../../hooks/session-end/index.js';

describe('cleanupTransientState — session-scoped hud-stdin-cache', () => {
  let tmpRoot: string;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'omc-session-end-cleanup-'));
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpRoot;
    process.env.USERPROFILE = tmpRoot;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
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

  it('preserves cancel-signal/stop-breaker in other session dirs', () => {
    // Transient markers can still be live cancellation state for another
    // session; SessionEnd must not erase them across ownership boundaries.
    const ending = join(tmpRoot, '.omc', 'state', 'sessions', 'session-ending');
    const other = join(tmpRoot, '.omc', 'state', 'sessions', 'session-other');
    mkdirSync(ending, { recursive: true });
    mkdirSync(other, { recursive: true });
    writeFileSync(join(ending, 'cancel-signal-state.json'), '{}');
    writeFileSync(join(other, 'autopilot-stop-breaker.json'), '{}');

    cleanupTransientState(tmpRoot, 'session-ending');

    expect(existsSync(join(ending, 'cancel-signal-state.json'))).toBe(false);
    expect(existsSync(join(other, 'autopilot-stop-breaker.json'))).toBe(true);
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

describe('cleanupTransientState — .tmp sweep spares in-flight publication temps', () => {
  let tmpRoot: string;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'omc-session-end-tmp-'));
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpRoot;
    process.env.USERPROFILE = tmpRoot;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('keeps a freshly written .tmp that a concurrent session may still be publishing', () => {
    // Atomic writers (e.g. ralph state) write <file>.tmp and rename it into
    // place immediately. A SessionEnd in another session must not unlink a
    // temp that is only milliseconds old — that would break the rename and
    // silently drop the other session's state update.
    const other = join(tmpRoot, '.omc', 'state', 'sessions', 'session-other');
    mkdirSync(other, { recursive: true });
    const inflight = join(other, 'ralph-state.json.tmp');
    writeFileSync(inflight, '{"awaiting_confirmation":true}');

    cleanupTransientState(tmpRoot, 'session-ending');

    expect(existsSync(inflight)).toBe(true);
  });

  it('still removes .tmp files older than the in-flight grace window', () => {
    const other = join(tmpRoot, '.omc', 'state', 'sessions', 'session-other');
    mkdirSync(other, { recursive: true });
    const stale = join(other, 'ralph-state.json.tmp');
    writeFileSync(stale, '{"awaiting_confirmation":true}');
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(stale, tenMinutesAgo, tenMinutesAgo);

    const removed = cleanupTransientState(tmpRoot, 'session-ending');

    expect(existsSync(stale)).toBe(false);
    expect(removed).toBeGreaterThanOrEqual(1);
  });

  it('removes aged .tmp files in nested directories below .omc/', () => {
    const nested = join(tmpRoot, '.omc', 'state', 'sessions', 'session-other', 'nested');
    mkdirSync(nested, { recursive: true });
    const stale = join(nested, 'checkpoint.json.tmp');
    writeFileSync(stale, '{}');
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(stale, oneHourAgo, oneHourAgo);

    cleanupTransientState(tmpRoot, 'session-ending');

    expect(existsSync(stale)).toBe(false);
  });
});
