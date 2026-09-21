/**
 * Jev judgment point: slop-warning (shadow) — recorder only, no runtime wiring.
 *
 * Ticket 12 of the Jev judgment-points feature. The slop-warning heuristic
 * (shouldWarnForSlopFallbackLanguage) lives in scripts/pre-tool-enforcer.mjs,
 * which cannot import TypeScript; wiring a runtime call would require either
 * porting the heuristic to TS or a CJS→ESM bridge. Until that follow-up
 * lands, this recorder is exported and tested only: callers (today, tests)
 * pass their already-computed warning decision as the twin.
 *
 * Advisory point, shadow-only: the twin always decides; Jev's Noul answer is
 * recorded only. The point declaration lives in the jev registry
 * (hooks/jev/points.ts).
 */

import { recordJudgment } from '../hooks/jev/index.js';
import type { ResolveResult } from '../hooks/jev/index.js';

export interface SlopWarningShadowArgs {
  /** The hook's already-computed slop-warning decision. */
  warned: boolean;
  toolName: string;
  /** The tool input inspected by the enforcer (strings bounded by the resolver). */
  toolInput: Record<string, unknown>;
  /** Test hook: injected transport. */
  fetchFn?: typeof fetch;
}

/**
 * Record the shadow comparison for one tool input and return the twin
 * decision unchanged. With no TYPESAFE_API_KEY (or OMC_JEV not naming this
 * point) the resolver short-circuits: zero HTTP calls, no logging, same
 * decision.
 */
export function recordSlopWarningShadow(
  args: SlopWarningShadowArgs,
): Promise<ResolveResult<boolean>> {
  return recordJudgment<boolean>('slop-warning', {
    state: {
      tool_name: args.toolName,
      tool_input: args.toolInput,
      source: 'pre-tool-enforcer',
    },
    twin: () => args.warned,
    fetchFn: args.fetchFn,
  });
}
