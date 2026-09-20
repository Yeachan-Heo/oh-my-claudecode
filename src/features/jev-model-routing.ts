/**
 * Jev judgment point ④: model-tier routing (shadow mode).
 *
 * Wraps the delegation enforcer's existing tier resolution as the heuristic
 * twin of `resolveJudgment` for the "model-routing" point. Shadow-only: Jev's
 * Choice is recorded for comparison and never overrides the enforcer while in
 * shadow. Detector-type point (blocking:false) — this is a high-frequency
 * pre-tool path, so the pinned tier returns immediately and the Jev call
 * settles in the background (issue-3669 latency policy).
 */

import { resolveJudgment, type JevQuestions, type ResolveResult } from '../hooks/jev/index.js';
import type { EnforcementResult } from './delegation-enforcer.js';

/**
 * Tier guidance from CLAUDE.md <model_routing> and docs/DELEGATION-ENFORCER.md:
 * haiku for quick lookups, sonnet for standard work, opus for architecture.
 */
const MODEL_ROUTING_QUESTIONS: JevQuestions = {
  'model-tier': {
    type: 'Choice',
    instructions: 'Which model tier should this delegated task use?',
    criteria: {
      haiku: 'Quick lookups and lightweight, mechanical work',
      sonnet: 'Standard coding and orchestration work',
      opus: 'Complex architecture and deep analysis',
    },
  },
};

/**
 * Record the shadow comparison for one delegated Task/Agent call.
 *
 * `pinned` is the enforcer's already-computed tier resolution; it is wrapped
 * as the twin (never recomputed, never overridden). With no TYPESAFE_API_KEY
 * or OMC_JEV=off the resolver answers "off" with zero HTTP calls and no log.
 * The returned promise resolves once the twin answer is available; the Jev
 * comparison log line settles asynchronously afterwards. Never rejects on the
 * Jev path.
 */
export function recordModelRoutingShadow(
  toolName: string,
  pinned: EnforcementResult,
  fetchFn?: typeof fetch,
): Promise<ResolveResult<EnforcementResult>> {
  return resolveJudgment<EnforcementResult>({
    point: 'model-routing',
    state: {
      tool_name: toolName,
      subagent_type: pinned.originalInput.subagent_type,
      task: pinned.originalInput.prompt,
    },
    questions: MODEL_ROUTING_QUESTIONS,
    twin: () => pinned,
    blocking: false,
    fetchFn,
  });
}
