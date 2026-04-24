import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';
import { getContextPercent, getModelName, getRateLimitsFromStdin, readStdinCache, stabilizeContextPercent, writeStdinCache, } from '../../hud/stdin.js';
function makeStdin(overrides = {}) {
    return {
        cwd: '/tmp/worktree',
        transcript_path: '/tmp/worktree/session.jsonl',
        model: {
            id: 'claude-sonnet',
            display_name: 'Claude Sonnet',
        },
        context_window: {
            context_window_size: 1000,
            current_usage: {
                input_tokens: 520,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
            },
            ...overrides.context_window,
        },
        ...overrides,
    };
}
describe('HUD stdin context percent', () => {
    it('prefers the native percentage when available', () => {
        const stdin = makeStdin({
            context_window: {
                used_percentage: 53.6,
                context_window_size: 1000,
                current_usage: {
                    input_tokens: 520,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                },
            },
        });
        expect(getContextPercent(stdin)).toBe(54);
    });
    it('reuses the previous native percentage when a transient fallback would cause ctx jitter', () => {
        const previous = makeStdin({
            context_window: {
                used_percentage: 54,
                context_window_size: 1000,
                current_usage: {
                    input_tokens: 540,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                },
            },
        });
        const current = makeStdin({
            context_window: {
                context_window_size: 1000,
                current_usage: {
                    input_tokens: 520,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                },
            },
        });
        expect(getContextPercent(current)).toBe(52);
        expect(getContextPercent(stabilizeContextPercent(current, previous))).toBe(54);
    });
    it('ignores cache_read_input_tokens in the manual fallback calculation', () => {
        const stdin = makeStdin({
            context_window: {
                context_window_size: 1000,
                current_usage: {
                    input_tokens: 120,
                    cache_creation_input_tokens: 30,
                    cache_read_input_tokens: 250_000,
                },
            },
        });
        expect(getContextPercent(stdin)).toBe(15);
    });
    it('keeps preferring native percentage even when cache reads are huge', () => {
        const stdin = makeStdin({
            context_window: {
                used_percentage: 54,
                context_window_size: 1000,
                current_usage: {
                    input_tokens: 120,
                    cache_creation_input_tokens: 30,
                    cache_read_input_tokens: 250_000,
                },
            },
        });
        expect(getContextPercent(stdin)).toBe(54);
    });
    it('does not hide a real context jump when the fallback differs materially', () => {
        const previous = makeStdin({
            context_window: {
                used_percentage: 80,
                context_window_size: 1000,
                current_usage: {
                    input_tokens: 800,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                },
            },
        });
        const current = makeStdin({
            context_window: {
                context_window_size: 1000,
                current_usage: {
                    input_tokens: 200,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                },
            },
        });
        expect(getContextPercent(stabilizeContextPercent(current, previous))).toBe(20);
    });
    it('does not let cache-read spikes interfere with stabilization decisions', () => {
        const previous = makeStdin({
            context_window: {
                used_percentage: 54,
                context_window_size: 1000,
                current_usage: {
                    input_tokens: 540,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                },
            },
        });
        const current = makeStdin({
            context_window: {
                context_window_size: 1000,
                current_usage: {
                    input_tokens: 520,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 250_000,
                },
            },
        });
        expect(getContextPercent(current)).toBe(52);
        expect(getContextPercent(stabilizeContextPercent(current, previous))).toBe(54);
    });
});
describe('HUD stdin model display', () => {
    it('prefers the official display_name over the raw model id', () => {
        expect(getModelName(makeStdin({
            model: {
                id: 'claude-sonnet-4-5-20250929',
                display_name: 'Claude Sonnet 4.5',
            },
        }))).toBe('Claude Sonnet 4.5');
    });
    it('falls back to the raw model id when display_name is unavailable', () => {
        expect(getModelName(makeStdin({
            model: {
                id: 'claude-sonnet-4-5-20250929',
            },
        }))).toBe('claude-sonnet-4-5-20250929');
    });
    it('returns Unknown when stdin omits the model block', () => {
        expect(getModelName(makeStdin({ model: undefined }))).toBe('Unknown');
    });
});
describe('HUD stdin rate limits', () => {
    it('parses stdin rate_limits into the existing RateLimits shape', () => {
        const result = getRateLimitsFromStdin(makeStdin({
            rate_limits: {
                five_hour: {
                    used_percentage: 11,
                    resets_at: 1776348000,
                },
                seven_day: {
                    used_percentage: 2,
                    resets_at: '2026-04-22T00:00:00.000Z',
                },
            },
        }));
        expect(result).toEqual({
            fiveHourPercent: 11,
            weeklyPercent: 2,
            fiveHourResetsAt: new Date(1776348000 * 1000),
            weeklyResetsAt: new Date('2026-04-22T00:00:00.000Z'),
        });
    });
    it('returns null when stdin omits rate limits', () => {
        expect(getRateLimitsFromStdin(makeStdin())).toBeNull();
    });
    it('tolerates invalid reset values without breaking the result', () => {
        const result = getRateLimitsFromStdin(makeStdin({
            rate_limits: {
                five_hour: {
                    used_percentage: 140,
                    resets_at: 'not-a-date',
                },
            },
        }));
        expect(result).toEqual({
            fiveHourPercent: 100,
            weeklyPercent: undefined,
            fiveHourResetsAt: null,
            weeklyResetsAt: null,
        });
    });
});
describe('HUD stdin cache path is session-scoped', () => {
    let tmpRoot;
    let originalCwd;
    const envKeys = ['CLAUDE_SESSION_ID', 'CLAUDECODE_SESSION_ID'];
    const savedEnv = {};
    beforeEach(() => {
        tmpRoot = mkdtempSync(join(tmpdir(), 'omc-hud-stdin-cache-'));
        // Make a real git repo so getWorktreeRoot() (which shells out to git
        // rev-parse) deterministically returns tmpRoot instead of leaking into
        // the surrounding workspace.
        execSync('git init --quiet', { cwd: tmpRoot });
        originalCwd = process.cwd();
        process.chdir(tmpRoot);
        for (const key of envKeys) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
        }
    });
    afterEach(() => {
        process.chdir(originalCwd);
        for (const key of envKeys) {
            if (savedEnv[key] === undefined) {
                delete process.env[key];
            }
            else {
                process.env[key] = savedEnv[key];
            }
        }
        rmSync(tmpRoot, { recursive: true, force: true });
    });
    it('writes to a session-scoped path when CLAUDE_SESSION_ID is set', () => {
        process.env.CLAUDE_SESSION_ID = 'test-session-aaa';
        const stdin = makeStdin({ cwd: tmpRoot });
        writeStdinCache(stdin);
        const expected = join(tmpRoot, '.omc', 'state', 'sessions', 'test-session-aaa', 'hud-stdin-cache.json');
        expect(existsSync(expected)).toBe(true);
        const loaded = JSON.parse(readFileSync(expected, 'utf-8'));
        expect(loaded.cwd).toBe(tmpRoot);
    });
    it('falls back to the legacy flat path when no session env var is set', () => {
        const stdin = makeStdin({ cwd: tmpRoot });
        writeStdinCache(stdin);
        const expected = join(tmpRoot, '.omc', 'state', 'hud-stdin-cache.json');
        expect(existsSync(expected)).toBe(true);
        const sessionScoped = join(tmpRoot, '.omc', 'state', 'sessions');
        expect(existsSync(sessionScoped)).toBe(false);
    });
    it('accepts CLAUDECODE_SESSION_ID as the session id source', () => {
        process.env.CLAUDECODE_SESSION_ID = 'test-session-bbb';
        const stdin = makeStdin({ cwd: tmpRoot });
        writeStdinCache(stdin);
        const expected = join(tmpRoot, '.omc', 'state', 'sessions', 'test-session-bbb', 'hud-stdin-cache.json');
        expect(existsSync(expected)).toBe(true);
    });
    it('prevents two concurrent sessions from clobbering each other', () => {
        process.env.CLAUDE_SESSION_ID = 'session-alpha';
        const alpha = makeStdin({ cwd: tmpRoot, transcript_path: `${tmpRoot}/alpha.jsonl` });
        writeStdinCache(alpha);
        process.env.CLAUDE_SESSION_ID = 'session-beta';
        const beta = makeStdin({ cwd: tmpRoot, transcript_path: `${tmpRoot}/beta.jsonl` });
        writeStdinCache(beta);
        // Reading back from each session must return its own snapshot.
        process.env.CLAUDE_SESSION_ID = 'session-alpha';
        expect(readStdinCache()?.transcript_path).toBe(`${tmpRoot}/alpha.jsonl`);
        process.env.CLAUDE_SESSION_ID = 'session-beta';
        expect(readStdinCache()?.transcript_path).toBe(`${tmpRoot}/beta.jsonl`);
    });
    it('readStdinCache ignores a legacy flat file when a session id is set', () => {
        const stateDir = join(tmpRoot, '.omc', 'state');
        mkdirSync(stateDir, { recursive: true });
        // Simulate a stale legacy cache written by an older build.
        const legacy = makeStdin({ cwd: '/legacy/cwd' });
        writeFileSync(join(stateDir, 'hud-stdin-cache.json'), JSON.stringify(legacy));
        process.env.CLAUDE_SESSION_ID = 'fresh-session';
        // Without a session file yet, read should miss rather than return the
        // legacy (cross-session) value.
        expect(readStdinCache()).toBeNull();
    });
    // ---------------------------------------------------------------------------
    // Unsafe / malformed session ids must NOT escape the session-scoped directory.
    //
    // `getStdinCachePath` delegates validation to the shared `resolveSessionStatePath`
    // helper (`validateSessionId`), so any id that fails the repo-wide contract
    // should fall back to the legacy flat path rather than being interpolated into
    // a filesystem path.
    // ---------------------------------------------------------------------------
    it.each([
        ['path traversal with ..', '../../../etc/passwd'],
        ['path traversal with parent only', '..'],
        ['forward slash', 'foo/bar'],
        ['backslash (Windows traversal)', 'foo\\bar'],
        ['leading underscore (regex first-char violation)', '_foo'],
        ['overlong id (>256 chars)', 'a'.repeat(300)],
    ])('rejects unsafe CLAUDE_SESSION_ID (%s) and falls back to the legacy path', (_label, unsafeId) => {
        process.env.CLAUDE_SESSION_ID = unsafeId;
        const stdin = makeStdin({ cwd: tmpRoot });
        writeStdinCache(stdin);
        // Nothing may be written to the session-scoped tree at all.
        const sessionsDir = join(tmpRoot, '.omc', 'state', 'sessions');
        expect(existsSync(sessionsDir)).toBe(false);
        // And in particular, nothing outside the intended state dir.
        const etcProbe = join(tmpRoot, 'etc', 'passwd');
        expect(existsSync(etcProbe)).toBe(false);
        // Legacy flat fallback should be populated instead.
        const legacy = join(tmpRoot, '.omc', 'state', 'hud-stdin-cache.json');
        expect(existsSync(legacy)).toBe(true);
    });
    it('treats whitespace-only CLAUDE_SESSION_ID as unset and falls back', () => {
        process.env.CLAUDE_SESSION_ID = '   ';
        const stdin = makeStdin({ cwd: tmpRoot });
        writeStdinCache(stdin);
        const sessionsDir = join(tmpRoot, '.omc', 'state', 'sessions');
        expect(existsSync(sessionsDir)).toBe(false);
        const legacy = join(tmpRoot, '.omc', 'state', 'hud-stdin-cache.json');
        expect(existsSync(legacy)).toBe(true);
    });
    it('falls through to CLAUDECODE_SESSION_ID when CLAUDE_SESSION_ID is empty', () => {
        // Regression for Codex review P2: `??` alone would accept "" as defined
        // and never consult the secondary variable.
        process.env.CLAUDE_SESSION_ID = '';
        process.env.CLAUDECODE_SESSION_ID = 'secondary-session';
        const stdin = makeStdin({ cwd: tmpRoot });
        writeStdinCache(stdin);
        const expected = join(tmpRoot, '.omc', 'state', 'sessions', 'secondary-session', 'hud-stdin-cache.json');
        expect(existsSync(expected)).toBe(true);
    });
    it('falls through to CLAUDECODE_SESSION_ID when CLAUDE_SESSION_ID is present but invalid', () => {
        // Regression for Codex review P2 (v2): a non-empty-but-invalid primary
        // must not silently bypass a valid secondary. The previous implementation
        // resolved the primary first, then fell straight to the legacy path when
        // validation threw, never giving the secondary a chance.
        process.env.CLAUDE_SESSION_ID = '../../../etc/passwd';
        process.env.CLAUDECODE_SESSION_ID = 'valid-secondary';
        const stdin = makeStdin({ cwd: tmpRoot });
        writeStdinCache(stdin);
        const expectedSecondary = join(tmpRoot, '.omc', 'state', 'sessions', 'valid-secondary', 'hud-stdin-cache.json');
        expect(existsSync(expectedSecondary)).toBe(true);
        // And in particular, the legacy flat path must NOT have been used —
        // otherwise concurrent sessions could still clobber each other.
        const legacy = join(tmpRoot, '.omc', 'state', 'hud-stdin-cache.json');
        expect(existsSync(legacy)).toBe(false);
        // Safety probe: traversal from primary must not have escaped.
        const etcProbe = join(tmpRoot, 'etc', 'passwd');
        expect(existsSync(etcProbe)).toBe(false);
    });
    it('falls back to the legacy path only when every candidate is invalid', () => {
        process.env.CLAUDE_SESSION_ID = '../traverse';
        process.env.CLAUDECODE_SESSION_ID = 'foo/bar';
        const stdin = makeStdin({ cwd: tmpRoot });
        writeStdinCache(stdin);
        const legacy = join(tmpRoot, '.omc', 'state', 'hud-stdin-cache.json');
        expect(existsSync(legacy)).toBe(true);
        const sessionsDir = join(tmpRoot, '.omc', 'state', 'sessions');
        expect(existsSync(sessionsDir)).toBe(false);
    });
});
describe('readStdinCache — env-less reader fallback to most recent session cache', () => {
    let tmpRoot;
    let originalCwd;
    const envKeys = ['CLAUDE_SESSION_ID', 'CLAUDECODE_SESSION_ID'];
    const savedEnv = {};
    beforeEach(() => {
        tmpRoot = mkdtempSync(join(tmpdir(), 'omc-hud-stdin-read-'));
        execSync('git init --quiet', { cwd: tmpRoot });
        originalCwd = process.cwd();
        process.chdir(tmpRoot);
        for (const key of envKeys) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
        }
    });
    afterEach(() => {
        process.chdir(originalCwd);
        for (const key of envKeys) {
            if (savedEnv[key] === undefined) {
                delete process.env[key];
            }
            else {
                process.env[key] = savedEnv[key];
            }
        }
        rmSync(tmpRoot, { recursive: true, force: true });
    });
    it('returns the most recently updated session cache when no session env is set', () => {
        // Simulate two concurrent sessions' writes by hand.
        const stale = join(tmpRoot, '.omc', 'state', 'sessions', 'session-old');
        const fresh = join(tmpRoot, '.omc', 'state', 'sessions', 'session-new');
        mkdirSync(stale, { recursive: true });
        mkdirSync(fresh, { recursive: true });
        const stalePayload = makeStdin({ transcript_path: '/tmp/old.jsonl' });
        const freshPayload = makeStdin({ transcript_path: '/tmp/new.jsonl' });
        writeFileSync(join(stale, 'hud-stdin-cache.json'), JSON.stringify(stalePayload));
        writeFileSync(join(fresh, 'hud-stdin-cache.json'), JSON.stringify(freshPayload));
        // Ensure mtime ordering is unambiguous even on low-resolution filesystems.
        const past = (Date.now() - 60_000) / 1000;
        const future = (Date.now() + 1_000) / 1000;
        utimesSync(join(stale, 'hud-stdin-cache.json'), past, past);
        utimesSync(join(fresh, 'hud-stdin-cache.json'), future, future);
        const got = readStdinCache();
        expect(got?.transcript_path).toBe('/tmp/new.jsonl');
    });
    it('prefers the legacy flat cache over the session-scoped fallback when both exist', () => {
        // A session wrote via the old (flat) path; an unrelated session dir
        // also happens to sit under state/sessions/. The legacy file should
        // win so callers that rely on the pre-session-scoping behavior keep
        // their existing semantics.
        const stateDir = join(tmpRoot, '.omc', 'state');
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(join(stateDir, 'hud-stdin-cache.json'), JSON.stringify(makeStdin({ transcript_path: '/tmp/legacy.jsonl' })));
        const some = join(stateDir, 'sessions', 'session-xyz');
        mkdirSync(some, { recursive: true });
        writeFileSync(join(some, 'hud-stdin-cache.json'), JSON.stringify(makeStdin({ transcript_path: '/tmp/scoped.jsonl' })));
        const got = readStdinCache();
        expect(got?.transcript_path).toBe('/tmp/legacy.jsonl');
    });
    it('returns null when nothing has been cached yet', () => {
        expect(readStdinCache()).toBeNull();
    });
    it('resolves the fallback directory through the same OMC_STATE_DIR helper as writers', () => {
        // Regression: the env-less fallback previously assembled the sessions
        // directory from `join(root, '.omc', 'state', 'sessions')` directly,
        // which bypasses `OMC_STATE_DIR`-backed centralized state and made
        // `omc hud --watch` miss the active cache in that deployment shape.
        const centralRoot = mkdtempSync(join(tmpdir(), 'omc-hud-stdin-central-'));
        const prevStateDir = process.env.OMC_STATE_DIR;
        process.env.OMC_STATE_DIR = centralRoot;
        try {
            // Writer pinned to a session id: must land under OMC_STATE_DIR/...,
            // not under `tmpRoot/.omc/state/sessions/...`.
            process.env.CLAUDE_SESSION_ID = 'central-session';
            const payload = makeStdin({ transcript_path: '/tmp/central.jsonl' });
            writeStdinCache(payload);
            // Sanity: nothing was written into the worktree-local .omc/ tree.
            expect(existsSync(join(tmpRoot, '.omc', 'state', 'sessions', 'central-session'))).toBe(false);
            // Env-less reader must still surface the same payload via the
            // shared helper, not via a hard-coded worktree-local path.
            delete process.env.CLAUDE_SESSION_ID;
            delete process.env.CLAUDECODE_SESSION_ID;
            const got = readStdinCache();
            expect(got?.transcript_path).toBe('/tmp/central.jsonl');
        }
        finally {
            if (prevStateDir === undefined) {
                delete process.env.OMC_STATE_DIR;
            }
            else {
                process.env.OMC_STATE_DIR = prevStateDir;
            }
            rmSync(centralRoot, { recursive: true, force: true });
        }
    });
    it('env-bound reader still reads from its own session-scoped path only', () => {
        // Regression: the fallback must not fire when an env var pins a
        // specific session — otherwise an unrelated session's cache could
        // be surfaced when the current session has not written anything yet.
        const mine = join(tmpRoot, '.omc', 'state', 'sessions', 'me');
        const theirs = join(tmpRoot, '.omc', 'state', 'sessions', 'them');
        mkdirSync(theirs, { recursive: true });
        writeFileSync(join(theirs, 'hud-stdin-cache.json'), JSON.stringify(makeStdin({ transcript_path: '/tmp/theirs.jsonl' })));
        process.env.CLAUDE_SESSION_ID = 'me';
        expect(readStdinCache()).toBeNull();
        // Once `me` writes, it gets its own snapshot.
        mkdirSync(mine, { recursive: true });
        writeFileSync(join(mine, 'hud-stdin-cache.json'), JSON.stringify(makeStdin({ transcript_path: '/tmp/mine.jsonl' })));
        expect(readStdinCache()?.transcript_path).toBe('/tmp/mine.jsonl');
    });
});
//# sourceMappingURL=stdin.test.js.map