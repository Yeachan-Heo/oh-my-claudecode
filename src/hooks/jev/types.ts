/**
 * Jev judgment-point types.
 *
 * Canonical vocabulary: CONTEXT.md § Jev integration
 * (judgment point, heuristic twin, shadow mode, degraded mode).
 */

/** The five judgment points, in delivery order. */
export type JudgmentPointName =
  | 'intent'
  | 'loop-continuation'
  | 'skill-trigger'
  | 'model-routing'
  | 'context-pruning'
  | 'task-size'
  | 'ralph-verdict'
  | 'learner-extraction'
  | 'slop-warning'
  | 'simplifier-trigger';

/** TypeSafe question shapes. */
export type JevQuestionType = 'Choice' | 'Score' | 'Noul';

export interface JevQuestionDef {
  type: JevQuestionType;
  instructions?: string;
  /** criterion name -> description */
  criteria: Record<string, string>;
}

/** Questions dict: name -> definition. */
export type JevQuestions = Record<string, JevQuestionDef>;

export interface JevAnswer {
  type: string;
  choice?: string;
  score?: number;
  noul?: boolean;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface JevUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface JevResponse {
  answers: Record<string, JevAnswer>;
  usage?: JevUsage;
}

/**
 * Why the resolver answered the way it did.
 * - shadow: twin decided; Jev's answer was recorded for comparison
 * - active: Jev's answer decided
 * - degraded: a shadow/active Jev call was attempted and failed (timeout,
 *   HTTP error, invalid response) — twin decided
 * - off: Jev disabled for this point (no key, master off, not in grayscale)
 * - cap: OMC_JEV_MAX_REQUESTS exhausted
 * - circuit-open: 3 consecutive failures opened this point's breaker
 */
export type ResolveMode = 'shadow' | 'active' | 'degraded' | 'off' | 'cap' | 'circuit-open';

export interface ResolveResult<T> {
  answer: T;
  source: 'twin' | 'jev';
  mode: ResolveMode;
}
