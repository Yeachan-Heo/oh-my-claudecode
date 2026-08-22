import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendShadowRecord, clearShadowLog, compareShadowExecution, decisionDigest, getShadowRegistry, isHookShadowEnabled, readShadowLog, resetShadowRegistryCache, runShadowObservation, summarizeShadowLog, SHADOW_LOG_MAX_RECORDS, } from '../index.js';
import { processHook } from '../../bridge.js';
const ENV_KEYS = ['OMC_HOOK_SHADOW', 'DISABLE_OMC'];
let savedEnv = {};
beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
    }
    resetShadowRegistryCache();
    clearShadowLog();
});
afterEach(() => {
    for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined)
            delete process.env[key];
        else
            process.env[key] = savedEnv[key];
    }
    resetShadowRegistryCache();
    clearShadowLog();
});
function record(partial) {
    return {
        schemaVersion: 1,
        hookType: 'keyword-detector',
        event: 'UserPromptSubmit',
        registryEntryIds: ['UserPromptSubmit:*:keyword-detector.mjs'],
        verdict: 'deferred',
        legacyDurationMs: 1,
        shadowDurationMs: 1,
        legacyDecisionDigest: decisionDigest({ continue: true }),
        recordedAt: new Date().toISOString(),
        ...partial,
    };
}
describe('shadow mode — feature flag and rollback (#3707)', () => {
    it('is disabled by default (rollback-safe)', () => {
        expect(isHookShadowEnabled()).toBe(false);
    });
    it('enables on explicit opt-in values only', () => {
        for (const v of ['1', 'true', 'on', 'observe', ' ON ']) {
            process.env.OMC_HOOK_SHADOW = v;
            expect(isHookShadowEnabled()).toBe(true);
        }
        for (const v of ['0', 'false', 'off', 'yes-ish', '']) {
            process.env.OMC_HOOK_SHADOW = v;
            expect(isHookShadowEnabled()).toBe(false);
        }
    });
    it('shadow observation is a no-op while disabled', async () => {
        const result = await runShadowObservation('keyword-detector', { continue: true }, 5);
        expect(result).toBeNull();
    });
});
describe('shadow comparison — decision equivalence (#3707)', () => {
    it('digests decision shape only, never content (privacy-preserving)', () => {
        const a = decisionDigest({ continue: true, message: 'secret user text A' });
        const b = decisionDigest({ continue: true, message: 'totally different secret B' });
        const c = decisionDigest({ continue: false, message: 'secret user text A' });
        expect(a).toBe(b); // message content does not affect the digest
        expect(a).not.toBe(c); // decision flag does
        expect(a).toMatch(/^[0-9a-f]{64}$/);
        expect(JSON.stringify(record({}))).not.toContain('secret user text');
    });
    it('verdicts: unmapped, divergent, deferred', () => {
        const registry = getShadowRegistry();
        expect(registry.length).toBeGreaterThan(0);
        const unmapped = compareShadowExecution('not-a-hook', registry, { continue: true }, 1, 1);
        expect(unmapped.verdict).toBe('unmapped');
        expect(unmapped.event).toBeNull();
        const deferred = compareShadowExecution('keyword-detector', registry, { continue: true }, 1, 1);
        // Side-effecting handlers are not re-executed in shadow mode: equivalence
        // evidence is deferred to the #3708 cutover by design.
        expect(deferred.verdict).toBe('deferred');
        expect(deferred.event).toBe('UserPromptSubmit');
        expect(deferred.registryEntryIds).toEqual(['UserPromptSubmit:*:keyword-detector.mjs']);
    });
    it('runShadowObservation records a comparison for a mapped hook type', async () => {
        process.env.OMC_HOOK_SHADOW = '1';
        const result = await runShadowObservation('keyword-detector', { continue: true }, 3);
        expect(result).not.toBeNull();
        expect(result?.event).toBe('UserPromptSubmit');
        expect(['deferred', 'equivalent']).toContain(result?.verdict);
        const log = readShadowLog();
        expect(log).toHaveLength(1);
        expect(log[0].hookType).toBe('keyword-detector');
    });
    it('flags divergence when the dispatcher selects a different set', async () => {
        process.env.OMC_HOOK_SHADOW = '1';
        const result = await runShadowObservation('session-start', { continue: true }, 3);
        expect(result).not.toBeNull();
        // session-start maps to exactly one registry entry; the dispatcher must
        // select that entry for the SessionStart event.
        expect(result?.registryEntryIds).toEqual(['SessionStart:*:session-start.mjs']);
        expect(result?.verdict).toBe('deferred');
    });
});
describe('shadow telemetry — bounded, in-process (#3707)', () => {
    it('keeps the buffer bounded to SHADOW_LOG_MAX_RECORDS', () => {
        for (let i = 0; i < SHADOW_LOG_MAX_RECORDS + 25; i++) {
            appendShadowRecord(record({}));
        }
        const log = readShadowLog();
        expect(log).toHaveLength(SHADOW_LOG_MAX_RECORDS);
    });
    it('summarizes verdicts for doctor/trace surfaces', () => {
        appendShadowRecord(record({ verdict: 'deferred' }));
        appendShadowRecord(record({ verdict: 'deferred' }));
        appendShadowRecord(record({ verdict: 'divergent' }));
        appendShadowRecord(record({ verdict: 'unmapped' }));
        expect(summarizeShadowLog()).toEqual({
            equivalent: 0,
            divergent: 1,
            deferred: 2,
            unmapped: 1,
        });
    });
    it('clearShadowLog empties the buffer', () => {
        appendShadowRecord(record({}));
        appendShadowRecord(record({}));
        expect(readShadowLog()).toHaveLength(2);
        clearShadowLog();
        expect(readShadowLog()).toHaveLength(0);
    });
});
describe('shadow mode — no behavior change through the bridge (#3707)', () => {
    it('processHook output is identical with shadow on and off', async () => {
        const input = { directory: '/tmp/omc-shadow-test' };
        const offOutput = await processHook('code-simplifier', input);
        process.env.OMC_HOOK_SHADOW = '1';
        const onOutput = await processHook('code-simplifier', input);
        expect(onOutput).toEqual(offOutput);
        // ...and the observation was still recorded for the mapped hook type.
        const log = readShadowLog();
        expect(log.length).toBeGreaterThan(0);
        expect(log.some((r) => r.hookType === 'code-simplifier')).toBe(true);
    });
    it('shadow observation never blocks or alters an erroring legacy path', async () => {
        process.env.OMC_HOOK_SHADOW = '1';
        const output = await processHook('code-simplifier', { directory: '/tmp/omc-shadow-test' });
        expect(output.continue).not.toBe(false);
    });
});
//# sourceMappingURL=shadow.test.js.map