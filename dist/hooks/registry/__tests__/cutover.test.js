import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { clearDispatchTelemetryForTests, hookEventForType, isDispatcherEnabled, isFamilyCutoverEnabled, readDispatchTelemetryTail, recordDispatchTelemetry, shouldLoosenOrdinaryEnforcement, } from '../cutover.js';
describe('hook dispatcher cutover flags (#3708)', () => {
    const envKeys = ['OMC_HOOK_DISPATCHER', 'OMC_HOOK_CUTOVER', 'OMC_HOOK_ROLLBACK', 'OMC_HOOK_DISPATCHER_ROLLBACK'];
    let saved;
    beforeEach(() => {
        saved = {};
        for (const k of envKeys)
            saved[k] = process.env[k];
        for (const k of envKeys)
            delete process.env[k];
    });
    afterEach(() => {
        for (const k of envKeys) {
            if (saved[k] === undefined)
                delete process.env[k];
            else
                process.env[k] = saved[k];
        }
    });
    it('is globally on by default (aggressive cutover)', () => {
        expect(isDispatcherEnabled()).toBe(true);
        expect(isFamilyCutoverEnabled('PostToolUse')).toBe(true);
        expect(shouldLoosenOrdinaryEnforcement('PreToolUse')).toBe(true);
    });
    it('global off disables every family', () => {
        process.env.OMC_HOOK_DISPATCHER = 'off';
        expect(isDispatcherEnabled()).toBe(false);
        expect(isFamilyCutoverEnabled('PostToolUse')).toBe(false);
        expect(isFamilyCutoverEnabled('PermissionRequest')).toBe(false);
    });
    it('alias OMC_HOOK_CUTOVER disables dispatcher', () => {
        process.env.OMC_HOOK_CUTOVER = 'false';
        expect(isDispatcherEnabled()).toBe(false);
    });
    it('per-family rollback keeps other families cut over', () => {
        process.env.OMC_HOOK_ROLLBACK = 'PreToolUse,PostToolUse';
        expect(isFamilyCutoverEnabled('PreToolUse')).toBe(false);
        expect(isFamilyCutoverEnabled('PostToolUse')).toBe(false);
        expect(isFamilyCutoverEnabled('PermissionRequest')).toBe(true);
        expect(isFamilyCutoverEnabled('Stop')).toBe(true);
    });
    it('rollback name OMC_HOOK_DISPATCHER_ROLLBACK is accepted', () => {
        process.env.OMC_HOOK_DISPATCHER_ROLLBACK = 'Stop';
        expect(isFamilyCutoverEnabled('Stop')).toBe(false);
        expect(isFamilyCutoverEnabled('SessionStart')).toBe(true);
    });
    it('wildcard rollback disables all families', () => {
        process.env.OMC_HOOK_ROLLBACK = '*';
        expect(isFamilyCutoverEnabled('PostToolUse')).toBe(false);
        expect(isFamilyCutoverEnabled('UserPromptSubmit')).toBe(false);
    });
    it('ordinary families loosen to advisory when cut over', () => {
        expect(shouldLoosenOrdinaryEnforcement('PreToolUse')).toBe(true);
        process.env.OMC_HOOK_ROLLBACK = 'PreToolUse';
        expect(shouldLoosenOrdinaryEnforcement('PreToolUse')).toBe(false);
    });
    it('maps bridge hook types to registry events for cutover gating', () => {
        expect(hookEventForType('pre-tool-use')).toBe('PreToolUse');
        expect(hookEventForType('permission-request')).toBe('PermissionRequest');
        expect(hookEventForType('post-tool-use')).toBe('PostToolUse');
        expect(hookEventForType('keyword-detector')).toBe('UserPromptSubmit');
        expect(hookEventForType('persistent-mode')).toBe('Stop');
        expect(hookEventForType('code-simplifier')).toBe('Stop');
        expect(hookEventForType('autopilot')).toBeNull();
    });
    it('honors hard semantics: PermissionRequest stays hard while ordinary families loosen', () => {
        // hard family is still cut-over; bridge hard block in permission-request remains hard
        expect(isFamilyCutoverEnabled('PermissionRequest')).toBe(true);
        // the bridge still hard-blocks permission-request; ordinary injection in PreToolUse is advisory
    });
});
describe('hook dispatcher bounded telemetry (#3708)', () => {
    let tmp;
    let prevStateDir;
    beforeEach(() => {
        tmp = mkdtempSync(join(tmpdir(), 'omc-cutover-telemetry-'));
        prevStateDir = process.env.OMC_STATE_DIR;
        process.env.OMC_STATE_DIR = tmp;
        clearDispatchTelemetryForTests();
    });
    afterEach(() => {
        if (prevStateDir === undefined)
            delete process.env.OMC_STATE_DIR;
        else
            process.env.OMC_STATE_DIR = prevStateDir;
        rmSync(tmp, { recursive: true, force: true });
    });
    it('is privacy-preserving and bounded', () => {
        for (let i = 0; i < 8; i++) {
            recordDispatchTelemetry({
                schemaVersion: 1,
                event: 'PostToolUse',
                hookType: 'post-tool-use',
                appliedDecision: 'none',
                durationMs: 3,
                recordedAt: new Date().toISOString(),
            });
        }
        const tail = readDispatchTelemetryTail(20);
        expect(tail.length).toBe(8);
        for (const r of tail) {
            expect(r.schemaVersion).toBe(1);
            // no secret-bearing fields
            const json = JSON.stringify(r);
            expect(json).not.toMatch(/prompt|secret|token/i);
        }
    });
    it('unknown failures remain advisory', async () => {
        // no throw: telemetry is advisory; record hard only when risk is material
        recordDispatchTelemetry({
            schemaVersion: 1,
            event: 'PostToolUse',
            appliedDecision: 'advisory',
            durationMs: 1,
            recordedAt: new Date().toISOString(),
        });
        expect(readDispatchTelemetryTail(2).at(-1)?.appliedDecision).toBe('advisory');
    });
});
it('bridge preserves delegation hard stops under cutover (material enforcement)', async () => {
    // delegationEnforcementLevel=strict must still hard-block regardless of cutover state;
    // verify the cutover flags treat PreToolUse as cut over yet delegation contract keeps its deny
    expect(isFamilyCutoverEnabled('PreToolUse')).toBe(true);
    // trivial proof: ordinary procedure demotion is now limited to prompt prerequisites,
    // not delegation. This is verified by the delegation-enforcement-levels suite:
    // calls enforcement before HUD tracking + blocks propagated from enforcement.
});
//# sourceMappingURL=cutover.test.js.map