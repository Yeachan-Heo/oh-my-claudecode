/**
 * Jev judgment point: ralph-verdict (shadow).
 *
 * Ticket 08 of the Jev judgment-points feature. Wraps the ralph completion
 * verification verdict — the detectArchitectApproval/detectArchitectRejection
 * outcome, which the code itself calls a rough heuristic — as the twin of a
 * gate-type resolveJudgment call. In shadow mode the twin always decides: the
 * verdict is byte-identical with and without TYPESAFE_API_KEY, and Jev's Noul
 * answer is recorded only. Degrade paths (timeout, HTTP error, invalid
 * response) are handled inside the resolver and can never alter the verdict;
 * the twin returns a captured value, so twin errors cannot occur.
 *
 * The point declaration (questions, blocking flag) lives in the jev registry
 * (hooks/jev/points.ts); this module keeps the call-specific state shape.
 */
import { recordJudgment } from '../jev/index.js';
/**
 * Record the shadow comparison for one completion-claim verdict and return
 * the twin verdict unchanged. With no TYPESAFE_API_KEY (or OMC_JEV not
 * naming this point) the resolver short-circuits: zero HTTP calls, no
 * logging, same verdict.
 */
export async function applyRalphVerdictShadow(args) {
    const { verdict } = args;
    await recordJudgment('ralph-verdict', {
        state: {
            verdict,
            prd_criteria: args.prdContext,
            claim: args.claim,
            critic_mode: args.criticMode ?? null,
        },
        twin: () => verdict,
        fetchFn: args.fetchFn,
    });
    return verdict;
}
//# sourceMappingURL=jev-shadow.js.map