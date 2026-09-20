/**
 * Shadow judgment points wired to the keyword detector (issue #3669,
 * tickets 02 + 04).
 *
 * Both points are detector-type (blocking:false): the detector's existing
 * computation is the heuristic twin and always decides; Jev's answer is only
 * recorded for later comparison. resolveJudgment never rejects on the Jev
 * path, so callers fire these without awaiting them — prompt submission
 * latency is unchanged. With TYPESAFE_API_KEY unset the resolver short-circuits
 * to the twin with zero HTTP calls.
 */

import {
  getAllKeywords,
  KEYWORD_PRIORITY,
  type KeywordType,
} from './index.js';
import { resolveJudgment } from '../jev/index.js';
import type { JevQuestions, ResolveResult } from '../jev/index.js';

/**
 * Top emit-able keyword types, derived from the detector's own priority
 * constants (team is excluded: its regex never matches, detection is
 * explicit-only via /team).
 */
const SKILL_TRIGGER_CRITERIA: Record<string, string> = {
  ...Object.fromEntries(
    KEYWORD_PRIORITY.filter((type) => type !== 'team')
      .slice(0, 12)
      .map((type) => [type, `The prompt explicitly invokes the ${type} trigger.`]),
  ),
  none: 'No trigger fires; handle the prompt without a mode or skill.',
};

const SKILL_TRIGGER_QUESTIONS: JevQuestions = {
  'skill-trigger': {
    type: 'Choice',
    instructions: 'Which skill or mode should this user prompt trigger?',
    criteria: SKILL_TRIGGER_CRITERIA,
  },
};

/**
 * Point "skill-trigger" (ticket 04): the keyword list decides; Jev's Choice
 * over the triggerable skills/modes is recorded per prompt.
 */
export function recordSkillTriggerShadow(
  prompt: string,
  fetchFn?: typeof fetch,
): Promise<ResolveResult<KeywordType[]>> {
  return resolveJudgment<KeywordType[]>({
    point: 'skill-trigger',
    state: { prompt, source: 'user-prompt-submit' },
    questions: SKILL_TRIGGER_QUESTIONS,
    twin: () => getAllKeywords(prompt),
    blocking: false,
    fetchFn,
  });
}

/**
 * Explicit slash invocation of the intent skill. Mirrors the detector's
 * WORKFLOW_SLASH_PATTERN shape for a skill outside
 * CANONICAL_WORKFLOW_SLASH_SKILLS: skills/intent/SKILL.md frontmatter sets
 * skills/intent/SKILL.md frontmatter sets disable-model-invocation, so an
 * explicit `/intent` (optionally namespaced) is the only trigger surface.
 */
const INTENT_SLASH_PATTERN = /^\s*\/(?:oh-my-claudecode:|omc:)?intent(?=\s|$|[?!.,;:])/i;

const INTENT_QUESTIONS: JevQuestions = {
  intent: {
    type: 'Noul',
    instructions:
      'Does this user prompt start an Intent-intake request (a non-engineer contributor stating a problem/goal/constraints to start the requirements intake flow)?',
    criteria: {
      true: 'The prompt states a problem, goal, or constraints from a contributor and starts the Intent intake — a goal-level intent.md with problem/goal/users-and-systems/constraints/open-questions, not a solution design.',
      false: 'Everything else: solution or engineering work, informational questions, or an existing workflow. Not an Intent-intake request.',
    },
  },
};

/**
 * Point "intent" (ticket 02): the detector's existing trigger answer decides;
 * Jev's Noul judgment is recorded per prompt.
 */
export function recordIntentShadow(
  prompt: string,
  fetchFn?: typeof fetch,
): Promise<ResolveResult<boolean>> {
  return resolveJudgment<boolean>({
    point: 'intent',
    state: { prompt, mode_name: 'intent' },
    questions: INTENT_QUESTIONS,
    twin: () => INTENT_SLASH_PATTERN.test(prompt),
    blocking: false,
    fetchFn,
  });
}
