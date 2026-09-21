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
 */

import { resolveJudgment } from '../jev/index.js';
import type { JevQuestions } from '../jev/index.js';

const VERDICT_QUESTIONS: JevQuestions = {
  completion_criteria_met: {
    type: 'Noul',
    instructions: 'Does the completion claim satisfy the PRD acceptance criteria for this mode?',
    criteria: {
      true: 'All acceptance criteria are demonstrably satisfied by the evidence',
      false: 'At least one criterion is unmet or evidence is missing',
    },
  },
};

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
 * the twin verdict unchanged. With no TYPESAFE_API_KEY (or OMC_JEV not
 * naming this point) the resolver short-circuits: zero HTTP calls, no
 * logging, same verdict.
 */
export async function applyRalphVerdictShadow(args: RalphVerdictShadowArgs): Promise<boolean> {
  const { verdict } = args;
  await resolveJudgment<boolean>({
    point: 'ralph-verdict',
    state: {
      verdict,
      prd_criteria: args.prdContext,
      claim: args.claim,
      critic_mode: args.criticMode ?? null,
    },
    questions: VERDICT_QUESTIONS,
    twin: () => verdict,
    blocking: true,
    fetchFn: args.fetchFn,
  });
  return verdict;
}
