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
import type { ShadowDecisionInput, HookRegistryEntry, ShadowComparisonRecord, ShadowVerdict } from './types.js';
/** Bounded in-process ring buffer: keep the most recent records only. */
export declare const SHADOW_LOG_MAX_RECORDS = 500;
/** Feature flag: shadow comparison is opt-in and defaults off. */
export declare function isHookShadowEnabled(): boolean;
/**
 * Normalized decision-shape digest: hashes only the decision structure
 * (continue flag, message presence, decision kind), never content.
 */
export declare function decisionDigest(output: ShadowDecisionInput | undefined): string;
/** Registry derived once per process from the installed hooks.json. */
export declare function getShadowRegistry(): readonly HookRegistryEntry[];
/** Reset cached registry (tests only). */
export declare function resetShadowRegistryCache(): void;
/**
 * Compare one legacy bridge execution against the registry dispatch for the
 * same event. Pure: performs no I/O and never throws.
 */
export declare function compareShadowExecution(hookType: string, registry: readonly HookRegistryEntry[], legacyOutput: ShadowDecisionInput | undefined, legacyDurationMs: number, shadowDurationMs: number): ShadowComparisonRecord;
/** Append one record to the bounded in-process ring buffer. */
export declare function appendShadowRecord(record: ShadowComparisonRecord): void;
/** Read the in-process shadow observation buffer. */
export declare function readShadowLog(): ShadowComparisonRecord[];
/** Aggregate counts for omc-doctor/trace style summaries. */
export declare function summarizeShadowLog(): Record<ShadowVerdict, number>;
/** Clear the in-process shadow observation buffer. */
export declare function clearShadowLog(): void;
/**
 * Record one shadow observation for a completed legacy bridge execution.
 * Never throws, never changes the legacy decision, and never exceeds
 * SHADOW_OBSERVATION_BUDGET_MS of added latency.
 */
export declare function runShadowObservation(hookType: string, legacyOutput: ShadowDecisionInput | undefined, legacyDurationMs: number): Promise<ShadowComparisonRecord | null>;
//# sourceMappingURL=shadow.d.ts.map