/**
 * Judgment-point registry - the single place a judgment point is declared.
 *
 * Each entry records the point's resolver key, its TypeSafe question sets,
 * and whether it is gate-type (blocking: callers wait on the Jev verdict) or
 * detector-type (non-blocking: the twin returns immediately, the Jev call
 * settles in the background). The registry holds declarations only; the one
 * execution path stays resolveJudgment (resolver.ts), reached through
 * recordJudgment below.
 *
 * Adding a judgment point (the ticket #8 precondition): one
 * defineJudgmentPoint entry here plus a thin recorder in the owning module -
 * no copied module.
 */

import { KEYWORD_PRIORITY } from '../keyword-detector/index.js';
import { resolveJudgment } from './resolver.js';
import type { JevQuestions, JudgmentPointName, ResolveResult } from './types.js';

/**
 * Top emit-able keyword types, derived from the detector's own priority
 * constants (team is excluded: its regex never matches, detection is
 * explicit-only via /team).
 */
function skillTriggerCriteria(): Record<string, string> {
  const priority = Array.isArray(KEYWORD_PRIORITY) ? KEYWORD_PRIORITY : [];
  return {
    ...Object.fromEntries(
      priority
        .filter((type) => type !== 'team')
        .slice(0, 12)
        .map((type) => [type, `The prompt explicitly invokes the ${type} trigger.`]),
    ),
    none: 'No trigger fires; handle the prompt without a mode or skill.',
  };
}

function skillTriggerQuestions(): JevQuestions {
  return {
    'skill-trigger': {
      type: 'Choice',
      instructions: 'Which skill or mode should this user prompt trigger?',
      criteria: skillTriggerCriteria(),
    },
  };
}

/** Point "intent" (ticket 02): Noul over Intent-intake requests. */
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
 * Point "loop-continuation" (ticket 03): the resolver logs one Jev answer per
 * shadow line, so the point resolves once per question (Noul, Score); both
 * calls share the same twin decision and iteration state.
 */
const NOUL_QUESTIONS: JevQuestions = {
  task_complete: {
    type: 'Noul',
    instructions: 'Is the task complete — is there no substantive work left for this mode?',
    criteria: {},
  },
};

const SCORE_QUESTIONS: JevQuestions = {
  iteration_progress: {
    type: 'Score',
    instructions: 'How much substantive progress did the current iteration make?',
    criteria: {
      no_progress: 'No progress',
      minor_progress: 'Minor progress',
      moderate_progress: 'Moderate progress',
      substantial_progress: 'Substantial progress',
    },
  },
};

/**
 * Point "model-routing" (ticket 04): tier guidance from CLAUDE.md
 * <model_routing> and docs/DELEGATION-ENFORCER.md - haiku for quick lookups,
 * sonnet for standard work, opus for architecture.
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
 * Point "context-pruning" (ticket 05): Score question aligned with the hook's
 * staleness view of context - usage below the warning threshold is fresh, at/
 * above warning is aging, at/above critical is a prune candidate.
 */
const STALENESS_QUESTIONS: JevQuestions = {
  staleness: {
    type: 'Score',
    instructions: 'How stale is this context candidate?',
    criteria: {
      fresh: 'Fresh — keep',
      recent: 'Recent',
      aging: 'Aging',
      stale: 'Stale — prune candidate',
    },
  },
};

/** Point "ralph-verdict" (ticket 08): Noul over the completion claim. */
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

/** Point "task-size" (ticket 09): Choice over small/medium/large. */
const TASK_SIZE_QUESTIONS: JevQuestions = {
  'task-size': {
    type: 'Choice',
    instructions: 'What size is this task — how much orchestration does it warrant?',
    criteria: {
      small: 'Single-file or few-line change; run directly without heavy modes',
      medium: 'Multi-file but single-area change; standard delegation',
      large: 'Multi-area or architectural change; heavy orchestration (ralph/autopilot/team) is warranted',
    },
  },
};

/**
 * Advisory points (ticket 12) — off/shadow only. Answers are context-only
 * and never gate behavior.
 */

/** Point "learner-extraction" (ticket 12): Noul over one assistant message. */
const LEARNER_EXTRACTION_QUESTIONS: JevQuestions = {
  extractable_moment: {
    type: 'Noul',
    instructions: 'Does this assistant message contain an extractable memory-worthy moment?',
    criteria: {
      true: 'Contains a reusable pattern, decision, or correction worth persisting',
      false: 'Routine work with nothing worth extracting',
    },
  },
};

/** Point "slop-warning" (ticket 12): Noul over one tool input. */
const SLOP_WARNING_QUESTIONS: JevQuestions = {
  slop_advisory: {
    type: 'Noul',
    instructions: 'Does this tool input contain fallback/workaround language worth an advisory warning?',
    criteria: {
      true: 'Contains fallback/workaround phrasing outside doc or self-referential context',
      false: 'No advisory-worthy language',
    },
  },
};

/** Point "simplifier-trigger" (ticket 12): Noul over one change. */
const SIMPLIFIER_TRIGGER_QUESTIONS: JevQuestions = {
  simplification_worthy: {
    type: 'Noul',
    instructions: 'Is this change simplification-worthy enough to inject the simplifier delegation?',
    criteria: {
      true: 'The change would benefit from a simplification pass (duplication, speculative flexibility, over-abstraction)',
      false: 'Change is already minimal or not code',
    },
  },
};

export interface JudgmentPointDefinition {
  /** Resolver key (the `point` argument) - also the registry key. */
  name: string;
  /**
   * Question sets for this point, in resolver-call order. Most points have
   * exactly one; loop-continuation resolves once per question (Noul, Score),
   * so it declares two. The function form is re-evaluated per call
   * (skill-trigger derives its criteria from the detector's KEYWORD_PRIORITY).
   */
  questions: readonly (JevQuestions | (() => JevQuestions))[];
  /** Gate-type points (true) wait on the Jev verdict; detector-type do not. */
  blocking: boolean;
}

/** Declare a judgment point. Declaration only - nothing here executes. */
export function defineJudgmentPoint(definition: {
  name: string;
  questions: JevQuestions | (() => JevQuestions) | readonly (JevQuestions | (() => JevQuestions))[];
  blocking: boolean;
}): JudgmentPointDefinition {
  return {
    name: definition.name,
    questions: Array.isArray(definition.questions) ? definition.questions : [definition.questions],
    blocking: definition.blocking,
  };
}

/** The judgment-point registry: name -> declaration. */
export const JUDGMENT_POINTS: Readonly<Record<JudgmentPointName, JudgmentPointDefinition>> = {
  intent: defineJudgmentPoint({ name: 'intent', questions: INTENT_QUESTIONS, blocking: false }),
  'loop-continuation': defineJudgmentPoint({
    name: 'loop-continuation',
    questions: [NOUL_QUESTIONS, SCORE_QUESTIONS],
    blocking: true,
  }),
  'skill-trigger': defineJudgmentPoint({ name: 'skill-trigger', questions: skillTriggerQuestions, blocking: false }),
  'model-routing': defineJudgmentPoint({ name: 'model-routing', questions: MODEL_ROUTING_QUESTIONS, blocking: false }),
  'context-pruning': defineJudgmentPoint({ name: 'context-pruning', questions: STALENESS_QUESTIONS, blocking: false }),
  'ralph-verdict': defineJudgmentPoint({ name: 'ralph-verdict', questions: VERDICT_QUESTIONS, blocking: true }),
  'task-size': defineJudgmentPoint({ name: 'task-size', questions: TASK_SIZE_QUESTIONS, blocking: false }),
  'learner-extraction': defineJudgmentPoint({
    name: 'learner-extraction',
    questions: LEARNER_EXTRACTION_QUESTIONS,
    blocking: false,
  }),
  'slop-warning': defineJudgmentPoint({ name: 'slop-warning', questions: SLOP_WARNING_QUESTIONS, blocking: false }),
  'simplifier-trigger': defineJudgmentPoint({
    name: 'simplifier-trigger',
    questions: SIMPLIFIER_TRIGGER_QUESTIONS,
    blocking: false,
  }),
};

/** Look up a declared judgment point. */
export function getJudgmentPoint(name: string): JudgmentPointDefinition {
  const point = JUDGMENT_POINTS[name as JudgmentPointName];
  if (!point) throw new Error('[jev] unknown judgment point: ' + name);
  return point;
}

export interface RecordJudgmentCall<T> {
  /** State the caller wants judged (bounded by the resolver before send/log). */
  state: unknown;
  /** Heuristic twin thunk. Errors propagate (twins must not be masked). */
  twin: () => T;
  /** Index into the point's question sets (loop-continuation's Score call uses 1). */
  questionSet?: number;
  /** Test hook: injected transport. */
  fetchFn?: typeof fetch;
}

/**
 * Record one shadow comparison at a declared judgment point. Thin wrapper
 * over resolveJudgment that fills in the registry's name, questions, and
 * blocking flag; the caller supplies only the call-specific state and twin.
 */
export function recordJudgment<T>(pointName: string, call: RecordJudgmentCall<T>): Promise<ResolveResult<T>> {
  const point = getJudgmentPoint(pointName);
  const questionSet = call.questionSet ?? 0;
  const questions = point.questions[questionSet];
  if (!questions) {
    throw new Error('[jev] ' + pointName + ': question set #' + questionSet + ' is not declared');
  }
  return resolveJudgment<T>({
    point: point.name,
    state: call.state,
    questions: typeof questions === 'function' ? questions() : questions,
    twin: call.twin,
    blocking: point.blocking,
    fetchFn: call.fetchFn,
  });
}
