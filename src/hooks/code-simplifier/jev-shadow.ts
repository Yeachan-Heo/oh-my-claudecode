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
import { recordJudgment } from '../jev/index.js';
import type { ResolveResult } from '../jev/index.js';

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
 * Record the shadow comparison for one stop event and return the twin
 * decision unchanged. With no TYPESAFE_API_KEY (or OMC_JEV not naming this
 * point) the resolver short-circuits: zero HTTP calls, no logging, same
 * decision.
 */
export function recordSimplifierTriggerShadow(
  args: SimplifierTriggerShadowArgs,
): Promise<ResolveResult<boolean>> {
  return recordJudgment<boolean>('simplifier-trigger', {
    state: {
      cwd: args.cwd,
      files: args.files,
      source: 'code-simplifier-stop',
    },
    twin: () => computeSimplifierTriggerTwin(args.stateDir, args.files),
    fetchFn: args.fetchFn,
  });
}
