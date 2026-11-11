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
import type { JevAnswer, JevQuestions, JudgmentPointName, ResolveResult } from './types.js';

/**
 * Top emit-able keyword types, derived from the detector's own priority
 * constants (team is excluded: its regex never matches, detection is
 * explicit-only via /team). Note: script-emitted triggers like 'ultragoal',
 * 'ai-slop-cleaner', and 'wiki' are not TypeScript KeywordType members and
 * will be logged as non-comparable by the mapHeuristic function.
 */
function skillTriggerCriteria(): Record<string, string> {
  const priority = Array.isArray(KEYWORD_PRIORITY) ? KEYWORD_PRIORITY : [];
  // Include all keywords except 'team' (explicit-only). Do not slice:
  // all keywords that can be detected and emitted should be in the criteria.
  return {
    ...Object.fromEntries(
      priority
        .filter((type) => type !== 'team')
        .map((type) => [type, `The prompt explicitly invokes the ${type} trigger.`]),
    ),
    none: 'No trigger fires; handle the prompt without a mode or skill.',
  };
}

function skillTriggerQuestions(): JevQuestions {
  return {
    'skill-trigger': {
      type: 'choice',
      instructions: 'Which skill or mode should this user prompt trigger?',
      criteria: skillTriggerCriteria(),
    },
  };
}

/** Point "intent" (ticket 02): Noul over Intent-intake requests. */
const INTENT_QUESTIONS: JevQuestions = {
  intent: {
    type: 'noul',
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
    type: 'noul',
    instructions: 'Is the task complete — is there no substantive work left for this mode?',
    criteria: {},
  },
};

const SCORE_QUESTIONS: JevQuestions = {
  iteration_progress: {
    type: 'score',
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
 * sonnet for standard work, opus for architecture. The "effort" score (0-4)
 * picks the subagent reasoning effort; scripts/pre-tool-enforcer.mjs maps it
 * to low/medium/high/xhigh/max in active mode, capped by OMC_JEV_MAX_EFFORT.
 */
const MODEL_ROUTING_QUESTIONS: JevQuestions = {
  'model-tier': {
    type: 'choice',
    instructions:
      'Which model should do this delegated task? Choose the cheapest model that will do the work well, meaning correctly and completely. ' +
      'Reasoning effort is chosen by a separate question, so the length of the brief and the number of steps do not by themselves call for a more expensive model. ' +
      'Judge the work the delegated agent must actually do; ' +
      'the formal conditions of the brief (language and style rules, permission to use subagents, bans, file locations, report format, words in capitals) and the name of the agent type do not raise the choice. ' +
      'A more expensive model is needed when a cheaper one would clearly be more likely to get this work wrong or to miss something important. ' +
      'When the brief fits several descriptions, judge by the hardest important part of the work.',
    criteria: {
      haiku: 'Haiku: mechanical work whose result follows directly from the data and is easy to check: look up, read, list, count, copy, compile a list, run a command and report the result, one obvious fix',
      sonnet: 'Sonnet: typical developer and analyst work with a clear goal: code changes in one or a few files, tests, a diagnosis with clear leads, gathering and summarising information from several files or sources, assessment following given instructions, translation, a document written from given sources, a deployment following given steps, coordinating agents',
      opus: 'Opus: work where a mistake is costly or hard to notice and that needs deep reasoning: architecture with tradeoffs, a hard bug without clear leads, an independent high-stakes review or fact-check, a letter or document on which money or important decisions depend, hard mathematics and proofs, deciding between conflicting sources, planning a large change',
    },
  },
  effort: {
    type: 'score',
    instructions:
      'How much reasoning effort does this delegated task need? Judge the work the delegated agent must actually do. ' +
      'The length of the brief and its formal conditions (language and style rules, permission to use subagents, bans, ' +
      'file locations, report format, words in capitals) do not raise the level.',
    criteria: {
      low: 'Low: mechanical work: read, look up, list, copy or transcribe, count; the result follows directly from the data',
      medium: 'Medium: a typical change or analysis with clear steps, in one place or following a given procedure or brief',
      high: 'High: multi-file work that needs its own decisions, a diagnosis weighing a few hypotheses, or writing a document',
      xhigh: 'Extra high: in-depth analysis, architecture, a high-stakes review, or a hard bug',
      max: 'Maximum: exceptionally hard, hours of reasoning at the limit of difficulty; rare',
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
    type: 'score',
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
    type: 'noul',
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
    type: 'choice',
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
    type: 'noul',
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
    type: 'noul',
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
    type: 'noul',
    instructions: 'Is this change simplification-worthy enough to inject the simplifier delegation?',
    criteria: {
      true: 'The change would benefit from a simplification pass (duplication, speculative flexibility, over-abstraction)',
      false: 'Change is already minimal or not code',
    },
  },
};

/**
 * Point "compaction": Score per tool result at a conversation compaction - how
 * much further work will still need it. Resolved by the Claude Code hooks
 * module hooks/jev-compaction.mjs (a mod cannot import this file, so it keeps a
 * copy of the question, locked by src/__tests__/jev-compaction-module.test.mjs),
 * not through recordJudgment. Named-only (NAMED_ONLY_POINTS in config.ts):
 * `all` never enables it.
 */
const COMPACTION_QUESTIONS: JevQuestions = {
  'result-need': {
    type: 'score',
    instructions:
      "How much will the tool result described under this question's name in state.results still be needed for further work on the user's task (state.task)? " +
      'Judge whether further work will use it, not whether it was needed before.',
    criteria: {
      not_needed: 'Not needed: the work it served is finished, or the result is easy to reproduce (a file listing, repository status, a write confirmation, a result repeated later).',
      probably_not_needed: 'Probably not needed: background from which further work needs at most a conclusion already written in the conversation.',
      may_be_useful: 'May be useful: details that further work may come back to.',
      needed: 'Needed: data that further work relies on and that is nowhere else in the conversation (file contents before an edit, numbers for later calculations, findings, an error to fix).',
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
  compaction: defineJudgmentPoint({ name: 'compaction', questions: COMPACTION_QUESTIONS, blocking: true }),
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
  /** Maps Jev's answer onto the result type. Only used in active mode. */
  mapAnswer?: (answer: JevAnswer) => T;
  /** Extracts the comparison-relevant heuristic value from the twin result for shadow logging.
   * When not provided, the full twin result is logged as the heuristic.
   * For judgment points with non-primitive twins, this should return the comparable primitive
   * (boolean for noul, string for choice, number for score). */
  mapHeuristic?: (twinResult: T, questionSet?: number) => unknown;
  /** Index into the point's question sets (loop-continuation's Score call uses 1).
   * Provided to mapHeuristic to allow conditional extraction of the right field. */
  questionSet?: number;
  /** Ids of the hook call for the log line (OMC_JEV_LOG_CONTEXT); see ResolveJudgmentArgs.logContext. */
  logContext?: unknown;
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
    mapAnswer: call.mapAnswer,
    mapHeuristic: call.mapHeuristic,
    questionSet,
    blocking: point.blocking,
    logContext: call.logContext,
    fetchFn: call.fetchFn,
  });
}
