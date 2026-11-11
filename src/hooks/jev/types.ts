/**
 * Jev judgment-point types.
 *
 * Canonical vocabulary: GLOSSARY.md § Jev integration
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
  | 'simplifier-trigger'
  | 'compaction';

/**
 * TypeSafe question shapes. The API rejects any other casing with HTTP 400,
 * so these literals are the wire values.
 */
export type JevQuestionType = 'choice' | 'score' | 'noul';

export interface JevQuestionDef {
  type: JevQuestionType;
  instructions?: string;
  /**
   * Criterion name -> description, in declaration order. `choice`/`noul` send
   * this map as-is; `score` is serialized to the ordered description list the
   * API requires (see serializeQuestions in client.ts).
   */
  criteria: Record<string, string>;
}

/** Questions dict: name -> definition. */
export type JevQuestions = Record<string, JevQuestionDef>;

export interface JevAnswer {
  type: string;
  choice?: string;
  score?: number;
  /** Probability of "yes" (0-1), as the API returns it; read it with noulAnswerIsYes(). */
  noul?: number | boolean;
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
 * Ids of the hook call behind one judgment, written to the Jev logs with
 * OMC_JEV_LOG_CONTEXT=1 and never sent to Jev. agent_id and agent_type are
 * set for a tool call made inside a subagent; request_id is new per request.
 */
export interface JevLogContext {
  tool_use_id?: string;
  session_id?: string;
  cwd?: string;
  agent_id?: string;
  agent_type?: string;
  prompt_id?: string;
  request_id?: string;
}

/**
 * Why the resolver answered the way it did.
 * - shadow: twin decided; Jev's answer was recorded for comparison
 * - active: Jev's answer decided
 * - degraded: a shadow/active Jev call was attempted and failed (timeout,
 *   HTTP error, invalid response) — twin decided
 * - off: Jev disabled for this point (no key, master off, not in grayscale)
 * - cap: OMC_JEV_MAX_REQUESTS exhausted, or the opt-in OMC_JEV_MAX_RPM limit
 *   reached for this point's priority in the current minute
 * - circuit-open: 3 consecutive failures opened this point's breaker, or the
 *   opt-in breaker shared by every process (OMC_JEV_BREAKER=1) is open
 */
export type ResolveMode = 'shadow' | 'active' | 'degraded' | 'off' | 'cap' | 'circuit-open';

export interface ResolveResult<T> {
  answer: T;
  source: 'twin' | 'jev';
  mode: ResolveMode;
}
