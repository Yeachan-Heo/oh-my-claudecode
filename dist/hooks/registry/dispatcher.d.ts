/**
 * Shadow-mode hook dispatcher — #3698 / #3707.
 *
 * Parses each event once, selects only applicable registry entries in
 * declared order, runs them with per-hook timeout enforcement, applies the
 * declared fail-mode (advisory fail-open with a structured diagnostic;
 * hard-risk fail-closed), and emits structured timing/error records.
 *
 * Shadow mode only: dry-run handlers execute and produce records, but no
 * output is ever merged into a runtime decision — behavior change is
 * impossible by construction. Cutover to active dispatch is #3708.
 *
 * Latency budget (plan §6.3): no-op events p95 <= 50 ms; ordinary advisory
 * events p95 <= 200 ms; no unbounded child process — handlers are in-process
 * functions, and every handler await is bounded by its declared timeout.
 */
import type { DispatchResult, HookEvent, HookHandler, HookRegistryEntry } from './types.js';
export interface HookDispatcher {
    dispatch(event: HookEvent, input: unknown): Promise<DispatchResult>;
    readonly registry: readonly HookRegistryEntry[];
}
export interface DispatcherOptions {
    /**
     * Dry-run handlers keyed by registry entry id. Only handlers with
     * `dryRun: true` execute; side-effecting handlers are skipped.
     */
    handlers?: ReadonlyMap<string, {
        handler: HookHandler;
        dryRun: boolean;
    }>;
    /** Injectable clock for tests. */
    now?: () => number;
}
export declare function createHookDispatcher(registry: readonly HookRegistryEntry[], options?: DispatcherOptions): HookDispatcher;
//# sourceMappingURL=dispatcher.d.ts.map