/**
 * Shadow-mode comparison observation — #3698 / #3707.
 *
 * Runs the registry dispatcher observably beside the current hook pipeline
 * and produces shadow-vs-legacy comparison records without changing any
 * decision (plan §8 step 5). Observation is in-process only: a bounded
 * ring buffer retains recent records for inspection by tests/doctor without
 * persisting to the filesystem (no ceremony layer, no state dir to clean up).
 *
 * Privacy-preserving (plan §9): records contain only hook ids, events,
 * durations, decision-shape digests, error classes, and verdicts — never
 * prompts, secrets, repository contents, or user text.
 *
 * Rollback: `OMC_HOOK_SHADOW` defaults to off; removing the shadow
 * registration (the wrapper in bridge.ts) fully restores prior behavior.
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { validateWorkingDirectory, } from '../../lib/worktree-paths.js';
import { createHookDispatcher } from './dispatcher.js';
import { buildHookRegistry } from './registry.js';
/** Bounded in-process ring buffer: keep the most recent records only. */
export const SHADOW_LOG_MAX_RECORDS = 500;
/** Hard cap on time spent observing; the legacy path is never delayed beyond this. */
const SHADOW_OBSERVATION_BUDGET_MS = 200;
let cachedRegistry = null;
const shadowBuffer = [];
/** Feature flag: shadow comparison is opt-in and defaults off. */
export function isHookShadowEnabled() {
    const env = process.env.OMC_HOOK_SHADOW;
    if (env === undefined)
        return false;
    const v = env.trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'on' || v === 'observe';
}
/**
 * Normalized decision-shape digest: hashes only the decision structure
 * (continue flag, message presence, decision kind), never content.
 */
export function decisionDigest(output) {
    const shape = {
        continue: output?.continue === false ? false : output?.continue === true ? true : undefined,
        hasMessage: typeof output?.message === 'string' && output.message.length > 0,
        decisionKind: output?.decision === undefined ? undefined : typeof output.decision,
    };
    return createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}
function loadHooksJson() {
    try {
        const raw = fs.readFileSync(path.join(validateWorkingDirectory(), 'hooks', 'hooks.json'), 'utf-8');
        const parsed = JSON.parse(raw);
        return parsed.hooks ?? null;
    }
    catch {
        return null;
    }
}
/** Registry derived once per process from the installed hooks.json. */
export function getShadowRegistry() {
    if (cachedRegistry)
        return cachedRegistry;
    const hooksJson = loadHooksJson();
    cachedRegistry = hooksJson ? buildHookRegistry(hooksJson) : [];
    return cachedRegistry;
}
/** Reset cached registry (tests only). */
export function resetShadowRegistryCache() {
    cachedRegistry = null;
}
/** Registry entries whose entrypoint maps to the given bridge hook type. */
function entriesForHookType(registry, hookType) {
    return registry.filter((e) => e.entrypoint === `${hookType}.mjs` || e.args.includes(hookType));
}
/**
 * Compare one legacy bridge execution against the registry dispatch for the
 * same event. Pure: performs no I/O and never throws.
 */
export function compareShadowExecution(hookType, registry, legacyOutput, legacyDurationMs, shadowDurationMs) {
    const entries = entriesForHookType(registry, hookType);
    const base = {
        schemaVersion: 1,
        hookType,
        registryEntryIds: entries.map((e) => e.id),
        legacyDurationMs,
        shadowDurationMs,
        legacyDecisionDigest: decisionDigest(legacyOutput),
        recordedAt: new Date().toISOString(),
    };
    if (entries.length === 0) {
        return { ...base, event: null, verdict: 'unmapped' };
    }
    const event = entries[0].event;
    // Selection/ordering equivalence: the observed bridge hook type must map to
    // exactly one registry entry and its event must be dispatchable in declared
    // order (order is structurally guaranteed by selectApplicableEntries).
    if (entries.length !== 1 || entries[0].order < 0) {
        return { ...base, event, verdict: 'divergent' };
    }
    // Decision equivalence is deferred for side-effecting handlers: shadow mode
    // does not re-execute them, so only the decision shape is compared against
    // the dispatcher's aggregate (which is always 'continue' with no handlers).
    return { ...base, event, verdict: 'deferred' };
}
/** Append one record to the bounded in-process ring buffer. */
export function appendShadowRecord(record) {
    shadowBuffer.push(record);
    if (shadowBuffer.length > SHADOW_LOG_MAX_RECORDS) {
        shadowBuffer.splice(0, shadowBuffer.length - SHADOW_LOG_MAX_RECORDS);
    }
}
/** Read the in-process shadow observation buffer. */
export function readShadowLog() {
    return [...shadowBuffer];
}
/** Aggregate counts for omc-doctor/trace style summaries. */
export function summarizeShadowLog() {
    const summary = {
        equivalent: 0,
        divergent: 0,
        deferred: 0,
        unmapped: 0,
    };
    for (const record of shadowBuffer) {
        summary[record.verdict] += 1;
    }
    return summary;
}
/** Clear the in-process shadow observation buffer. */
export function clearShadowLog() {
    shadowBuffer.length = 0;
}
/**
 * Record one shadow observation for a completed legacy bridge execution.
 * Never throws, never changes the legacy decision, and never exceeds
 * SHADOW_OBSERVATION_BUDGET_MS of added latency.
 */
export async function runShadowObservation(hookType, legacyOutput, legacyDurationMs) {
    if (!isHookShadowEnabled())
        return null;
    const started = performance.now();
    try {
        const registry = getShadowRegistry();
        const entries = entriesForHookType(registry, hookType);
        const event = entries.length > 0 ? entries[0].event : null;
        // Run the dispatcher in shadow mode for the same event: this exercises
        // selection/ordering/timeout/fail-mode logic with dry-run handlers only.
        let shadowDurationMs = 0;
        let verdict = null;
        if (event !== null) {
            const dispatcher = createHookDispatcher(registry, {});
            const dispatchResult = await Promise.race([
                dispatcher.dispatch(event, {}),
                new Promise((resolve) => setTimeout(() => resolve(null), SHADOW_OBSERVATION_BUDGET_MS)),
            ]);
            shadowDurationMs = performance.now() - started;
            if (dispatchResult === null) {
                verdict = 'divergent';
            }
            else if (entries.length === 1) {
                // No dry-run handlers are registered by default, so decision
                // equivalence remains deferred; selection equivalence holds when the
                // dispatcher selected the same single entry.
                const selected = dispatchResult.records.map((r) => r.hookId);
                verdict = selected.includes(entries[0].id) ? 'deferred' : 'divergent';
            }
        }
        const record = {
            ...compareShadowExecution(hookType, registry, legacyOutput, legacyDurationMs, shadowDurationMs),
            ...(verdict !== null ? { verdict } : {}),
        };
        appendShadowRecord(record);
        return record;
    }
    catch (error) {
        // Shadow observation is advisory and always fails open.
        return {
            schemaVersion: 1,
            hookType,
            event: null,
            registryEntryIds: [],
            verdict: 'unmapped',
            legacyDurationMs,
            shadowDurationMs: performance.now() - started,
            legacyDecisionDigest: decisionDigest(legacyOutput),
            errorClass: error instanceof Error ? error.name : 'UnknownError',
            recordedAt: new Date().toISOString(),
        };
    }
}
//# sourceMappingURL=shadow.js.map