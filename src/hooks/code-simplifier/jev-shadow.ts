/**
 * Jev judgment point: simplifier-trigger (shadow).
 *
 * Ticket 12 of the Jev judgment-points feature. Wraps the code-simplifier
 * stop hook's fire-once heuristic (the processCodeSimplifier shouldBlock
 * decision, replicated here without the marker write) as the twin of a
 * detector-type resolveJudgment call. Advisory point, shadow-only: the twin
 * always decides; Jev's Noul answer is recorded only and never gates the
 * simplifier delegation. Degrade paths are handled inside the resolver.
 *
 * The point declaration (questions, blocking flag) lives in the jev registry
 * (hooks/jev/points.ts); this module keeps the twin and the call-specific
 * state shape.
 */

import {
  isAlreadyTriggered,
  isCodeSimplifierEnabled,
} from './index.js';
import { isJevStateOmitIdsEnabled, noulAnswerIsYes, recordJudgment } from '../jev/index.js';
import type { JevAnswer, ResolveResult } from '../jev/index.js';

export interface SimplifierTriggerShadowArgs {
  cwd: string;
  stateDir: string;
  /** Modified-file list already computed by the host hook (avoid re-running git). */
  files: string[];
  /** The host hook's already-computed shouldBlock decision. */
  shouldBlock: boolean;
  /** Test hook: injected transport. */
  fetchFn?: typeof fetch;
}

/**
 * The fire-once heuristic, computed side-effect-free (no marker write).
 * Mirrors processCodeSimplifier's early-return logic.
 */
export function computeSimplifierTriggerTwin(
  stateDir: string,
  files: string[],
): boolean {
  if (!isCodeSimplifierEnabled()) return false;
  if (isAlreadyTriggered(stateDir)) return false;
  return files.length > 0;
}

/**
 * Record the shadow comparison for one stop event and return the decision
 * (twin in shadow/off mode, Jev-mapped in active mode). With no
 * TYPESAFE_API_KEY (or OMC_JEV not naming this point) the resolver
 * short-circuits: zero HTTP calls, no logging, same decision. Jev errors
 * degrade inside the resolver and fall back to the twin.
 */
export function recordSimplifierTriggerShadow(
  args: SimplifierTriggerShadowArgs,
): Promise<ResolveResult<boolean>> {
  return recordJudgment<boolean>('simplifier-trigger', {
    state: {
      // The working directory names the machine, not the change: left out with OMC_JEV_STATE_OMIT_IDS=1.
      ...(isJevStateOmitIdsEnabled() ? {} : { cwd: args.cwd }),
      files: args.files,
      source: 'code-simplifier-stop',
    },
    twin: () => computeSimplifierTriggerTwin(args.stateDir, args.files),
    mapHeuristic: (result, questionSet) => result,
    mapAnswer: (answer: JevAnswer) => {
      // Jev Noul answer: noul is the probability of "yes" (0-1)
      return noulAnswerIsYes(answer);
    },
    logContext: { cwd: args.cwd },
    fetchFn: args.fetchFn,
  });
}
