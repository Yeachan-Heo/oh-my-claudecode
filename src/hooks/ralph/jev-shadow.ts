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

import { noulAnswerIsYes, recordJudgment } from '../jev/index.js';
import type { JevAnswer } from '../jev/index.js';

export interface RalphVerdictShadowArgs {
  /** The existing verification verdict: true = approved, false = rejected. */
  verdict: boolean;
  /** PRD acceptance-criteria excerpt (the resolver bounds all strings). */
  prdContext: string;
  /** Completion-claim summary metadata. */
  claim: string;
  /** Reviewer mode metadata ('architect' | 'critic' | 'codex'). */
  criticMode?: string;
  /** Test hook: injected transport. */
  fetchFn?: typeof fetch;
}

/**
 * Record the shadow comparison for one completion-claim verdict and return
 * the result (twin verdict in shadow/off mode, Jev-mapped in active mode).
 * With no TYPESAFE_API_KEY (or OMC_JEV not naming this point) the resolver
 * short-circuits: zero HTTP calls, no logging, same verdict. Jev errors
 * degrade inside the resolver and fall back to the twin.
 */
export async function applyRalphVerdictShadow(args: RalphVerdictShadowArgs): Promise<boolean> {
  const { verdict } = args;
  const result = await recordJudgment<boolean>('ralph-verdict', {
    state: {
      verdict,
      prd_criteria: args.prdContext,
      claim: args.claim,
      critic_mode: args.criticMode ?? null,
    },
    twin: () => verdict,
    mapHeuristic: (result, questionSet) => result,
    mapAnswer: (answer: JevAnswer) => {
      // Jev Noul answer: noul is the probability of "yes" (0-1)
      return noulAnswerIsYes(answer);
    },
    fetchFn: args.fetchFn,
  });
  
  // In active mode, use Jev's verdict instead of the heuristic
  if (result.mode === 'active') {
    return result.answer;
  }
  
  // Shadow/off/degraded: return the original heuristic verdict
  return verdict;
}
