import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getContextPercent } from '../hud/stdin.js';
// @ts-expect-error Local hook helper is a JS module loaded directly by the tests.
import { resolveContextPercent, resolveHookContextPercent, resolveHudCacheContextPercent, resolveTranscriptContextPercent } from '../../scripts/lib/context-usage.mjs';
const HUD_CACHE_FILENAME = 'hud-stdin-cache.json';
function writeTranscript(payload) {
    const filePath = join(tempDir, `transcript-${Date.now()}-${Math.random()}.jsonl`);
    writeFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf-8');
    return filePath;
}
function writeHudCache(sessionId, payload) {
    const sessionDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
    mkdirSync(sessionDir, { recursive: true });
    const filePath = join(sessionDir, HUD_CACHE_FILENAME);
    writeFileSync(filePath, JSON.stringify(payload), 'utf-8');
    return filePath;
}
function makeHudPayload(overrides = {}) {
    return {
        cwd: tempDir,
        transcript_path: join(tempDir, 'session.jsonl'),
        context_window: {
            context_window_size: 1000,
            current_usage: {
                input_tokens: 120,
                cache_creation_input_tokens: 30,
                cache_read_input_tokens: 50,
            },
        },
        ...overrides,
    };
}
let tempDir;
let originalPluginRoot;
beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'omc-context-usage-'));
    originalPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = process.cwd();
});
afterEach(() => {
    if (originalPluginRoot === undefined) {
        delete process.env.CLAUDE_PLUGIN_ROOT;
    }
    else {
        process.env.CLAUDE_PLUGIN_ROOT = originalPluginRoot;
    }
    rmSync(tempDir, { recursive: true, force: true });
});
describe('resolveTranscriptContextPercent', () => {
    it('returns null for production-shaped transcripts without context_window', () => {
        const transcriptPath = writeTranscript({
            message: {
                usage: {
                    input_tokens: 850,
                    cache_creation_input_tokens: 50,
                    cache_read_input_tokens: 50,
                    output_tokens: 10,
                },
            },
        });
        expect(resolveTranscriptContextPercent(transcriptPath)).toBeNull();
    });
    it('includes cache creation and cache read tokens when context_window is present', () => {
        const transcriptPath = writeTranscript({
            message: {
                usage: {
                    context_window: 1000,
                    input_tokens: 120,
                    cache_creation_input_tokens: 30,
                    cache_read_input_tokens: 250,
                    output_tokens: 10,
                },
            },
        });
        // input_tokens alone would be 12%; normalized HUD accounting is 40%.
        expect(resolveTranscriptContextPercent(transcriptPath)).toBe(40);
    });
});
describe('resolveHookContextPercent', () => {
    it('prefers used_percentage when present', () => {
        expect(resolveHookContextPercent({
            context_window: { used_percentage: 53.6 },
        })).toBe(54);
    });
    it('derives usage from current_usage including cache tokens', () => {
        expect(resolveHookContextPercent({
            context_window: {
                context_window_size: 100,
                current_usage: {
                    input_tokens: 60,
                    cache_creation_input_tokens: 5,
                    cache_read_input_tokens: 7,
                },
            },
        })).toBe(72);
    });
    it('returns null when context_window is missing or malformed', () => {
        expect(resolveHookContextPercent({})).toBeNull();
        expect(resolveHookContextPercent({ context_window: null })).toBeNull();
        expect(resolveHookContextPercent({
            context_window: { context_window_size: 100 },
        })).toBeNull();
    });
});
describe('resolveHudCacheContextPercent', () => {
    it('uses HUD native used_percentage from the session cache', async () => {
        const sessionId = 'hud-native-session';
        const payload = makeHudPayload({
            context_window: {
                used_percentage: 42.6,
                context_window_size: 1000,
                current_usage: {
                    input_tokens: 1,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                },
            },
        });
        writeHudCache(sessionId, payload);
        expect(await resolveHudCacheContextPercent({ session_id: sessionId }, tempDir)).toBe(getContextPercent(payload));
    });
    it('delegates current_usage accounting to the HUD implementation', async () => {
        const sessionId = 'hud-current-usage-session';
        const payload = makeHudPayload();
        writeHudCache(sessionId, payload);
        expect(await resolveHudCacheContextPercent({ session_id: sessionId }, tempDir)).toBe(getContextPercent(payload));
    });
    it('falls back to the most recently modified session cache', async () => {
        const oldPath = writeHudCache('hud-old-session', makeHudPayload({
            context_window: { used_percentage: 12 },
        }));
        const freshPath = writeHudCache('hud-fresh-session', makeHudPayload({
            context_window: { used_percentage: 67 },
        }));
        const past = (Date.now() - 60_000) / 1000;
        const future = (Date.now() + 1_000) / 1000;
        utimesSync(oldPath, past, past);
        utimesSync(freshPath, future, future);
        expect(await resolveHudCacheContextPercent({}, tempDir)).toBe(67);
    });
    it('uses the env-identified session cache even when a foreign session cache is newer', async () => {
        const envSessionPath = writeHudCache('hud-env-session', makeHudPayload({
            context_window: { used_percentage: 30 },
        }));
        const foreignPath = writeHudCache('hud-foreign-session', makeHudPayload({
            context_window: { used_percentage: 91 },
        }));
        const past = (Date.now() - 60_000) / 1000;
        const future = (Date.now() + 1_000) / 1000;
        utimesSync(envSessionPath, past, past);
        utimesSync(foreignPath, future, future);
        const originalSessionEnv = process.env.CLAUDE_SESSION_ID;
        process.env.CLAUDE_SESSION_ID = 'hud-env-session';
        try {
            // No session_id on the payload itself: identity must come from the env
            // var, not from scanning for the most recently modified cache — a
            // concurrent unrelated session's newer cache must never be selected
            // once an identity is known.
            expect(await resolveHudCacheContextPercent({}, tempDir)).toBe(30);
        }
        finally {
            if (originalSessionEnv === undefined) {
                delete process.env.CLAUDE_SESSION_ID;
            }
            else {
                process.env.CLAUDE_SESSION_ID = originalSessionEnv;
            }
        }
    });
    it('falls back to the legacy flat cache before scanning sessions when no identity is known', async () => {
        const legacyDir = join(tempDir, '.omc', 'state');
        mkdirSync(legacyDir, { recursive: true });
        const legacyPayload = makeHudPayload({ context_window: { used_percentage: 55 } });
        writeFileSync(join(legacyDir, HUD_CACHE_FILENAME), JSON.stringify(legacyPayload), 'utf-8');
        // A session-scoped cache also exists and is newer, but with no payload
        // session_id and no session-id env vars set, the legacy flat cache (the
        // env-less path the HUD itself reads/writes) must win over any
        // mtime-based session scan.
        const sessionPath = writeHudCache('hud-unrelated-session', makeHudPayload({
            context_window: { used_percentage: 88 },
        }));
        utimesSync(sessionPath, (Date.now() + 1_000) / 1000, (Date.now() + 1_000) / 1000);
        const originalClaudeSession = process.env.CLAUDE_SESSION_ID;
        const originalLegacySession = process.env.CLAUDECODE_SESSION_ID;
        delete process.env.CLAUDE_SESSION_ID;
        delete process.env.CLAUDECODE_SESSION_ID;
        try {
            expect(await resolveHudCacheContextPercent({}, tempDir)).toBe(55);
        }
        finally {
            if (originalClaudeSession !== undefined)
                process.env.CLAUDE_SESSION_ID = originalClaudeSession;
            if (originalLegacySession !== undefined)
                process.env.CLAUDECODE_SESSION_ID = originalLegacySession;
        }
    });
    it('skips an invalid CLAUDE_SESSION_ID and falls back to a valid CLAUDECODE_SESSION_ID', async () => {
        const validPath = writeHudCache('hud-valid-secondary', makeHudPayload({
            context_window: { used_percentage: 44 },
        }));
        void validPath;
        const originalClaude = process.env.CLAUDE_SESSION_ID;
        const originalLegacy = process.env.CLAUDECODE_SESSION_ID;
        // '../evil' is a session id that fails validation (path-traversal shape)
        // and must not stop the search — the next candidate should still be tried.
        process.env.CLAUDE_SESSION_ID = '../evil';
        process.env.CLAUDECODE_SESSION_ID = 'hud-valid-secondary';
        try {
            expect(await resolveHudCacheContextPercent({}, tempDir)).toBe(44);
        }
        finally {
            if (originalClaude === undefined)
                delete process.env.CLAUDE_SESSION_ID;
            else
                process.env.CLAUDE_SESSION_ID = originalClaude;
            if (originalLegacy === undefined)
                delete process.env.CLAUDECODE_SESSION_ID;
            else
                process.env.CLAUDECODE_SESSION_ID = originalLegacy;
        }
    });
    it('skips an invalid payload session_id and falls back to a valid env identity', async () => {
        writeHudCache('hud-valid-env-fallback', makeHudPayload({
            context_window: { used_percentage: 61 },
        }));
        const originalClaude = process.env.CLAUDE_SESSION_ID;
        process.env.CLAUDE_SESSION_ID = 'hud-valid-env-fallback';
        try {
            expect(await resolveHudCacheContextPercent({ session_id: '../evil' }, tempDir)).toBe(61);
        }
        finally {
            if (originalClaude === undefined)
                delete process.env.CLAUDE_SESSION_ID;
            else
                process.env.CLAUDE_SESSION_ID = originalClaude;
        }
    });
    it('falls back to the legacy flat cache when every identity candidate is invalid', async () => {
        const legacyDir = join(tempDir, '.omc', 'state');
        mkdirSync(legacyDir, { recursive: true });
        const legacyPayload = makeHudPayload({ context_window: { used_percentage: 38 } });
        writeFileSync(join(legacyDir, HUD_CACHE_FILENAME), JSON.stringify(legacyPayload), 'utf-8');
        const originalClaude = process.env.CLAUDE_SESSION_ID;
        const originalLegacy = process.env.CLAUDECODE_SESSION_ID;
        process.env.CLAUDE_SESSION_ID = '../also-evil';
        delete process.env.CLAUDECODE_SESSION_ID;
        try {
            expect(await resolveHudCacheContextPercent({ session_id: '../still-evil' }, tempDir)).toBe(38);
        }
        finally {
            if (originalClaude === undefined)
                delete process.env.CLAUDE_SESSION_ID;
            else
                process.env.CLAUDE_SESSION_ID = originalClaude;
            if (originalLegacy === undefined)
                delete process.env.CLAUDECODE_SESSION_ID;
            else
                process.env.CLAUDECODE_SESSION_ID = originalLegacy;
        }
    });
    it('returns null for a valid but cache-less primary identity instead of falling through to a secondary candidate', async () => {
        // 'hud-valid-primary-no-cache' is a syntactically valid session id with
        // no cache file written for it. A valid identity is authoritative the
        // moment it is found (matching src/hud/stdin.ts's getStdinCachePath,
        // which commits to the first candidate that passes validation) -- it
        // must NOT fall through to a different, unrelated secondary candidate
        // even if that candidate happens to have a cache.
        writeHudCache('hud-unrelated-secondary-with-cache', makeHudPayload({
            context_window: { used_percentage: 77 },
        }));
        const originalLegacy = process.env.CLAUDECODE_SESSION_ID;
        process.env.CLAUDECODE_SESSION_ID = 'hud-unrelated-secondary-with-cache';
        try {
            expect(await resolveHudCacheContextPercent({ session_id: 'hud-valid-primary-no-cache' }, tempDir)).toBeNull();
        }
        finally {
            if (originalLegacy === undefined)
                delete process.env.CLAUDECODE_SESSION_ID;
            else
                process.env.CLAUDECODE_SESSION_ID = originalLegacy;
        }
    });
    it('returns null for a valid payload identity with no cache even when a newer foreign session cache exists', async () => {
        const foreignPath = writeHudCache('hud-foreign-high-session', makeHudPayload({
            context_window: { used_percentage: 90 },
        }));
        utimesSync(foreignPath, (Date.now() + 1_000) / 1000, (Date.now() + 1_000) / 1000);
        // The current session's own identity ('hud-valid-payload-no-cache') is
        // syntactically valid but has not written a cache yet (e.g. before the
        // first statusline render). It must resolve to null, never to a
        // concurrent unrelated session's high-percentage cache -- otherwise a
        // fresh session could be falsely warned/blocked by another session's
        // context usage.
        expect(await resolveHudCacheContextPercent({ session_id: 'hud-valid-payload-no-cache' }, tempDir)).toBeNull();
    });
    it('returns null for a valid env-bound identity with no cache even when the legacy flat cache is populated', async () => {
        const legacyDir = join(tempDir, '.omc', 'state');
        mkdirSync(legacyDir, { recursive: true });
        writeFileSync(join(legacyDir, HUD_CACHE_FILENAME), JSON.stringify(makeHudPayload({ context_window: { used_percentage: 95 } })), 'utf-8');
        const originalClaude = process.env.CLAUDE_SESSION_ID;
        process.env.CLAUDE_SESSION_ID = 'hud-valid-env-no-cache';
        try {
            // A valid env-bound identity with no cache of its own must resolve to
            // null, never to the legacy flat cache -- the legacy path is reserved
            // for the fully identity-less case (src/hud/stdin.ts readStdinCache
            // only falls back to it when no session env var resolved at all).
            expect(await resolveHudCacheContextPercent({}, tempDir)).toBeNull();
        }
        finally {
            if (originalClaude === undefined)
                delete process.env.CLAUDE_SESSION_ID;
            else
                process.env.CLAUDE_SESSION_ID = originalClaude;
        }
    });
    it('returns null when CLAUDE_PLUGIN_ROOT is unavailable', async () => {
        delete process.env.CLAUDE_PLUGIN_ROOT;
        expect(await resolveHudCacheContextPercent({ session_id: 'missing-root' }, tempDir)).toBeNull();
    });
    it('returns null when the cache file is missing', async () => {
        expect(await resolveHudCacheContextPercent({ session_id: 'missing-cache' }, tempDir)).toBeNull();
    });
    it('returns null when the cache has no context_window key', async () => {
        writeHudCache('missing-context-key', {
            cwd: tempDir,
            current_usage: { input_tokens: 1000 },
        });
        expect(await resolveHudCacheContextPercent({ session_id: 'missing-context-key' }, tempDir)).toBeNull();
    });
});
describe('resolveContextPercent orchestration', () => {
    it('prefers transcript, then hook payload, then HUD cache', async () => {
        const transcriptPath = writeTranscript({
            message: {
                usage: {
                    context_window: 1000,
                    input_tokens: 800,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                },
            },
        });
        writeHudCache('orchestration-session', makeHudPayload({
            context_window: { used_percentage: 45 },
        }));
        expect(await resolveContextPercent({
            session_id: 'orchestration-session',
            context_window: { used_percentage: 60 },
        }, transcriptPath, tempDir)).toBe(80);
        const missingTranscript = join(tempDir, 'missing.jsonl');
        expect(await resolveContextPercent({
            session_id: 'orchestration-session',
            context_window: { used_percentage: 60 },
        }, missingTranscript, tempDir)).toBe(60);
        expect(await resolveContextPercent({ session_id: 'orchestration-session' }, missingTranscript, tempDir)).toBe(45);
        expect(await resolveContextPercent({}, missingTranscript, tempDir)).toBe(45);
    });
    it('returns null when no source has usable context data', async () => {
        expect(await resolveContextPercent({}, join(tempDir, 'missing.jsonl'), tempDir)).toBeNull();
    });
});
//# sourceMappingURL=context-usage.test.js.map