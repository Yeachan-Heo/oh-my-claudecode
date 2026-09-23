/**
 * Judgment resolver - the single seam every judgment point consults.
 *
 * Dispatches a named judgment across the off | shadow | active tri-state:
 * - off / cap / circuit-open: twin decides, no fetch, no log
 * - shadow: twin decides; the Jev call is made (waited on unless
 *   blocking:false) and the comparison logged
 * - active: Jev answer decides; the twin result is preserved in the log
 *
 * Degrade paths (timeout, HTTP error, invalid response) return the twin and
 * log mode:"degraded". The resolver never throws and never rejects on the
 * Jev path - only twin() (and mapAnswer()) errors propagate, because twins
 * are existing repo code whose bugs must not be masked.
 */
import type { JevAnswer, JevQuestions, ResolveResult } from './types.js';
/** Reset in-process resolver state (request cap, circuit breaker). Test hook. */
export declare function resetJevResolverState(): void;
export interface ResolveJudgmentArgs<T> {
    /** Judgment point name, e.g. "intent" or "model-routing". */
    point: string;
    /** State the caller wants judged. Strings are bounded before send/log. */
    state: unknown;
    /** TypeSafe questions object (Choice/Score/Noul definitions). */
    questions: JevQuestions;
    /** Heuristic twin thunk. Errors propagate (twins must not be masked). */
    twin: () => T;
    /**
     * Maps Jev's first answer onto the twin's result type. Defaults to an
     * unchecked cast. Only used in active mode.
     */
    mapAnswer?: (answer: JevAnswer) => T;
    /**
     * Force "shadow" or "active" for this call, overriding code activation.
     * Config-off still wins.
     */
    mode?: 'shadow' | 'active';
    /**
     * Wait for the Jev call before returning. Default true (gate-type points).
     * Detector-type points pass false: twin returns immediately, the Jev call
     * is fire-and-forget and the comparison is logged when it settles.
     */
    blocking?: boolean;
    /** Test hook: injected transport. */
    fetchFn?: typeof fetch;
}
export declare function resolveJudgment<T>(args: ResolveJudgmentArgs<T>): Promise<ResolveResult<T>>;
//# sourceMappingURL=resolver.d.ts.map