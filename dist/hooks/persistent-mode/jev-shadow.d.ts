/**
 * Jev judgment point: loop-continuation (shadow).
 *
 * Ticket 03 of the Jev judgment-points feature (issue-3669). Wraps the
 * persistent-mode Stop hook's continuation decision (continue vs bypass vs
 * inject a continuation message) as the heuristic twin of a gate-type
 * resolveJudgment call. In shadow mode the twin always decides — the hook's
 * output is byte-identical with and without TYPESAFE_API_KEY — and Jev's
 * Noul/Score answers are recorded only.
 *
 * The point declaration (both question sets, blocking) lives in the jev
 * registry (hooks/jev/points.ts). The resolver logs one Jev answer per shadow
 * line, so the point resolves once per question (Noul, Score); both calls
 * share the same twin decision and iteration state.
 */
import type { PersistentModeResult } from './index.js';
export interface LoopContinuationShadowArgs {
    /** The Stop hook's existing continuation decision (the twin). */
    result: PersistentModeResult;
    sessionId?: string;
    /** Test hook: injected transport. */
    fetchFn?: typeof fetch;
}
/**
 * Record the shadow comparison for one loop-continuation decision and return
 * the twin unchanged. With no TYPESAFE_API_KEY (or OMC_JEV=off / grayscale
 * exclusion) the resolver short-circuits: zero HTTP calls, no logging, and
 * the result is returned as-is. Jev errors degrade inside the resolver and
 * can never alter the returned decision; the twin returns a captured value
 * so twin errors cannot occur.
 */
export declare function applyLoopContinuationShadow(args: LoopContinuationShadowArgs): Promise<PersistentModeResult>;
//# sourceMappingURL=jev-shadow.d.ts.map