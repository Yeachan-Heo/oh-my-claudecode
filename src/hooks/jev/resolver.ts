/**
 * Judgment resolver - the single seam every judgment point consults.
 *
 * Dispatches a named judgment across the off | shadow | active tri-state:
 * - off / cap / circuit-open: twin decides, no fetch, no log
 * - shadow: twin decides; the Jev call is made (waited on unless
 *   blocking:false) and the comparison logged
 * - active: Jev answer decides; the twin result is preserved in the log
 *
 * Degrade paths (timeout, HTTP error, invalid response) return the twin and
 * log mode:"degraded". The resolver never throws and never rejects on the
 * Jev path - only twin() (and mapAnswer()) errors propagate, because twins
 * are existing repo code whose bugs must not be masked.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { queryJev } from './client.js';
import { ACTIVATED_POINTS, boundExcerpts, excerptCharsFor, parseJevConfig, pointState } from './config.js';
import type { JevAnswer, JevQuestions, JevResponse, JevUsage, ResolveMode, ResolveResult } from './types.js';

const CIRCUIT_FAILURE_THRESHOLD = 3;

interface ResolverRuntime {
  requestCount: number;
  consecutiveFailures: Map<string, number>;
  openCircuits: Set<string>;
  /** env-activated points already warned about (warn once per point per process). */
  envWarned: Set<string>;
}

const runtime: ResolverRuntime = {
  requestCount: 0,
  consecutiveFailures: new Map(),
  openCircuits: new Set(),
  envWarned: new Set<string>(),
};

/** Reset in-process resolver state (request cap, circuit breaker, warnings). Test hook. */
export function resetJevResolverState(): void {
  runtime.requestCount = 0;
  runtime.consecutiveFailures.clear();
  runtime.openCircuits.clear();
  runtime.envWarned.clear();
}

export interface ResolveJudgmentArgs<T> {
  /** Judgment point name, e.g. "intent" or "model-routing". */
  point: string;
  /** State the caller wants judged. Strings are bounded before send/log. */
  state: unknown;
  /** TypeSafe questions object (Choice/Score/Noul definitions). */
  questions: JevQuestions;
  /** Heuristic twin thunk. Errors propagate (twins must not be masked). */
  twin: () => T;
  /**
   * Maps Jev's first answer onto the twin's result type. Defaults to an
   * unchecked cast. Only used in active mode.
   */
  mapAnswer?: (answer: JevAnswer) => T;
  /**
   * Extracts the comparison-relevant heuristic value from the twin result for shadow logging.
   * When not provided, the full twin result is logged as the heuristic.
   * For judgment points with non-primitive twins, this should return the comparable primitive
   * (boolean for noul, string for choice, number for score).
   * The optional questionSet parameter is provided when the point has multiple question sets.
   */
  mapHeuristic?: (twinResult: T, questionSet?: number) => unknown;
  /**
   * Index into the point's question sets (loop-continuation's Score call uses 1).
   * Provided to mapHeuristic to allow conditional extraction of the right field.
   */
  questionSet?: number;
  /**
   * Force "shadow" or "active" for this call, overriding code activation.
   * Config-off still wins.
   */
  mode?: 'shadow' | 'active';
  /**
   * Wait for the Jev call before returning. Default true (gate-type points).
   * Detector-type points pass false: twin returns immediately, the Jev call
   * is fire-and-forget and the comparison is logged when it settles.
   */
  blocking?: boolean;
  /** Test hook: injected transport. */
  fetchFn?: typeof fetch;
}

interface ShadowLogEntry {
  ts: string;
  point: string;
  mode: 'shadow' | 'active' | 'degraded';
  state: unknown;
  heuristic: unknown;
  jev: unknown;
  /** Every Jev answer by question name; null on degraded lines. */
  answers: Record<string, JevAnswer> | null;
  confidence?: number;
  durationMs: number;
  /** Jev-reported token usage; absent on degraded lines. */
  usage?: JevUsage;
}

/** Keep only finite, non-negative token counts; the client does not validate `usage`. */
function sanitizeUsage(usage: unknown): JevUsage | undefined {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return undefined;
  const { input_tokens, output_tokens } = usage as Record<string, unknown>;
  const isCount = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;
  return isCount(input_tokens) && isCount(output_tokens) ? { input_tokens, output_tokens } : undefined;
}

/**
 * The answer to the first question asked. The API does not guarantee the
 * order of its answers object, so look it up by name; fall back to the first
 * answer in server order when that name is missing.
 */
function firstAnswer(response: JevResponse, questions: JevQuestions): JevAnswer {
  const firstQuestion = Object.keys(questions)[0];
  if (firstQuestion !== undefined && Object.hasOwn(response.answers, firstQuestion)) {
    return response.answers[firstQuestion];
  }
  return Object.values(response.answers)[0] as JevAnswer;
}

/** Best-effort JSONL append under the shadow-log dir. Never throws. */
async function writeShadowLog(entry: ShadowLogEntry, logDir: string): Promise<void> {
  try {
    await mkdir(logDir, { recursive: true });
    await appendFile(join(logDir, 'shadow.jsonl'), JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Best-effort logging: a logging failure must never affect the judgment.
  }
}

function recordSuccess(point: string): void {
  runtime.consecutiveFailures.delete(point);
}

function recordFailure(point: string): void {
  const count = (runtime.consecutiveFailures.get(point) ?? 0) + 1;
  runtime.consecutiveFailures.set(point, count);
  if (count >= CIRCUIT_FAILURE_THRESHOLD) {
    runtime.openCircuits.add(point);
    console.error('[jev] ' + point + ': circuit open after ' + count + ' consecutive failures');
  }
}

/** Extract the loggable heuristic value, applying mapHeuristic if provided. */
/**
 * A logged heuristic is comparable with the logged Jev answer only when it is
 * a valid answer to the same question: the first declared question, whose
 * answer is the one logged. Anything else is logged as null (non-comparable).
 */
export function comparableHeuristic(value: unknown, questions: JevQuestions): string | number | boolean | null {
  const question = Object.values(questions)[0];
  if (!question) return null;
  switch (question.type) {
    case 'choice':
      return typeof value === 'string' && Object.hasOwn(question.criteria ?? {}, value) ? value : null;
    case 'noul':
      return typeof value === 'boolean' ? value : null;
    case 'score':
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    default:
      return null;
  }
}

function extractHeuristicForLogging<T>(twinResult: T, questions: JevQuestions, mapHeuristic: ((result: T, questionSet?: number) => unknown) | undefined, questionSet?: number): string | number | boolean | null {
  return comparableHeuristic(mapHeuristic ? mapHeuristic(twinResult, questionSet) : twinResult, questions);
}

export async function resolveJudgment<T>(resolveJudgmentArgs: ResolveJudgmentArgs<T>): Promise<ResolveResult<T>> {
  const args = resolveJudgmentArgs;
  const config = parseJevConfig();
  let mode: ResolveMode = pointState(args.point, config);
  if (args.mode && mode !== 'off') mode = args.mode;

  // One stderr line when env activation makes Jev decide (warn once per
  // point per process; code-activated and caller-forced stay silent).
  // OMC_JEV_QUIET=1 silences the line: hook processes are one-shot, so
  // per-process once is per-call in practice.
  if (
    process.env.OMC_JEV_QUIET !== '1' &&
    mode === 'active' &&
    !args.mode &&
    !ACTIVATED_POINTS.has(args.point) &&
    (config.activateAll || config.activatedPoints.has(args.point)) &&
    !runtime.envWarned.has(args.point)
  ) {
    runtime.envWarned.add(args.point);
    console.error('[jev] ' + args.point + ': ACTIVE via env — Jev decides');
  }

  const twinAnswer = (): T => args.twin();

  // Twin-decided, no-fetch paths. twin() errors propagate by design.
  if (mode === 'off') {
    return { answer: twinAnswer(), source: 'twin', mode };
  }
  if (runtime.openCircuits.has(args.point)) {
    return { answer: twinAnswer(), source: 'twin', mode: 'circuit-open' };
  }
  if (config.maxRequests > 0 && runtime.requestCount >= config.maxRequests) {
    return { answer: twinAnswer(), source: 'twin', mode: 'cap' };
  }

  // Only the state carries user text; question definitions are static (they must never embed user text) and go out whole.
  const boundedState = boundExcerpts(args.state, excerptCharsFor(args.point, config));
  const startedAt = Date.now();

  const attempt = (async () => {
    try {
      return { ok: true as const, response: await queryJev(boundedState, args.questions, {
        endpoint: config.endpoint,
        apiKey: config.apiKey as string,
        timeoutMs: config.timeoutMs,
        fetchFn: args.fetchFn,
      }) };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  })();
  runtime.requestCount += 1;

  // Non-blocking (detector-type) in shadow mode: return the twin now; log when Jev settles.
  if (mode === 'shadow' && args.blocking === false) {
    const heuristic = twinAnswer();
    const loggableHeuristic = extractHeuristicForLogging(heuristic, args.questions, args.mapHeuristic, args.questionSet);
    void attempt.then((outcome) => {
      if (outcome.ok) {
        recordSuccess(args.point);
        void writeShadowLog(buildLogEntry(args.point, boundedState, startedAt, 'shadow', loggableHeuristic, outcome.response, args.questions), config.logDir);
      } else {
        recordFailure(args.point);
        void writeShadowLog(buildLogEntry(args.point, boundedState, startedAt, 'degraded', loggableHeuristic, null), config.logDir);
      }
      // Belt-and-braces: a future throw in this callback must never become an
      // unhandled rejection that kills a one-shot hook process.
    }).catch(() => {});
    return { answer: heuristic, source: 'twin', mode: 'shadow' };
  }
  
  // Non-blocking (detector-type) in active mode: wait for Jev (bounded by timeout)
  // to enable active mode to work with non-blocking points.
  if (mode === 'active' && args.blocking === false) {
    const heuristic = twinAnswer();
    const loggableHeuristic = extractHeuristicForLogging(heuristic, args.questions, args.mapHeuristic, args.questionSet);
    const outcome = await attempt;
    if (!outcome.ok) {
      recordFailure(args.point);
      await writeShadowLog(buildLogEntry(args.point, boundedState, startedAt, 'degraded', loggableHeuristic, null), config.logDir);
      return { answer: heuristic, source: 'twin', mode: 'degraded' };
    }
    recordSuccess(args.point);
    const jevAnswer = firstAnswer(outcome.response, args.questions);
    await writeShadowLog(buildLogEntry(args.point, boundedState, startedAt, 'active', loggableHeuristic, outcome.response, args.questions), config.logDir);
    const answer = args.mapAnswer ? args.mapAnswer(jevAnswer) : (jevAnswer as unknown as T);
    return { answer, source: 'jev', mode: 'active' };
  }

  const outcome = await attempt;
  if (!outcome.ok) {
    recordFailure(args.point);
    console.error('[jev] ' + args.point + ': degraded - ' + outcome.error);
    const heuristic = twinAnswer();
    const loggableHeuristic = extractHeuristicForLogging(heuristic, args.questions, args.mapHeuristic, args.questionSet);
    await writeShadowLog(buildLogEntry(args.point, boundedState, startedAt, 'degraded', loggableHeuristic, null), config.logDir);
    return { answer: heuristic, source: 'twin', mode: 'degraded' };
  }

  recordSuccess(args.point);
  const heuristic = twinAnswer();
  const loggableHeuristic = extractHeuristicForLogging(heuristic, args.questions, args.mapHeuristic, args.questionSet);
  const jevAnswer = firstAnswer(outcome.response, args.questions);
  await writeShadowLog(buildLogEntry(args.point, boundedState, startedAt, mode === 'active' ? 'active' : 'shadow', loggableHeuristic, outcome.response, args.questions), config.logDir);
  if (mode === 'active') {
    const answer = args.mapAnswer ? args.mapAnswer(jevAnswer) : (jevAnswer as unknown as T);
    return { answer, source: 'jev', mode: 'active' };
  }
  return { answer: heuristic, source: 'twin', mode: 'shadow' };
}

/** Build one shadow-log comparison line. */
function buildLogEntry(
  point: string,
  boundedState: unknown,
  startedAt: number,
  entryMode: ShadowLogEntry['mode'],
  heuristic: unknown,
  response: JevResponse | null,
  questions?: JevQuestions,
): ShadowLogEntry {
  const jev = response ? firstAnswer(response, questions ?? {}) : null;
  const safeUsage = sanitizeUsage(response?.usage);
  return {
    ts: new Date().toISOString(),
    point,
    mode: entryMode,
    state: boundedState,
    heuristic,
    jev,
    answers: response ? response.answers : null,
    confidence: jev?.confidence,
    durationMs: Date.now() - startedAt,
    ...(safeUsage ? { usage: safeUsage } : {}),
  };
}
