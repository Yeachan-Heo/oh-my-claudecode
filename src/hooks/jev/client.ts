/**
 * Zero-dependency Jev client (TypeSafe System One).
 *
 * POSTs {state, questions, model:"jev-latest"} with bearer auth and an
 * AbortController timeout. No retry — the interactive path degrades instead.
 * Throws JevClientError on any failure; the resolver catches and degrades.
 */

import type { JevAnswer, JevQuestionDef, JevQuestions, JevResponse } from './types.js';

/** What a failed request tells about the endpoint (read by the opt-in shared breaker). */
export interface JevFailureDetails {
  /** HTTP status of a non-2xx response. */
  status?: number;
  /** Retry-After header of that response. */
  retryAfter?: string;
  /** No HTTP response arrived at all: timeout or network error. */
  noResponse?: boolean;
}

export class JevClientError extends Error {
  readonly status?: number;
  readonly retryAfter?: string;
  readonly noResponse?: boolean;

  constructor(message: string, details: JevFailureDetails = {}) {
    super(message);
    this.name = 'JevClientError';
    this.status = details.status;
    this.retryAfter = details.retryAfter;
    this.noResponse = details.noResponse;
  }
}

export interface JevClientOptions {
  endpoint: string;
  apiKey: string;
  timeoutMs: number;
  /** Test hook: injected transport. Defaults to globalThis.fetch. */
  fetchFn?: typeof fetch;
}

export async function queryJev(
  state: unknown,
  questions: JevQuestions,
  options: JevClientOptions,
): Promise<JevResponse> {
  const fetchFn = options.fetchFn ?? fetch;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let responded = false;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new JevClientError(`jev request timed out after ${options.timeoutMs}ms`, { noResponse: !responded }));
    }, options.timeoutMs);
  });
  try {
    const response = await Promise.race([fetchFn(options.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({ state, questions: serializeQuestions(questions), model: JEV_MODEL }),
      signal: controller.signal,
    }), timeoutPromise]);
    responded = true;
    if (!response.ok) {
      throw new JevClientError(`jev request failed: HTTP ${response.status}`, {
        status: response.status,
        retryAfter: response.headers?.get?.('retry-after') ?? undefined,
      });
    }
    const body: unknown = await response.json();
    return validateJevResponse(body);
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof JevClientError)) {
      throw new JevClientError(`jev request timed out after ${options.timeoutMs}ms`, { noResponse: !responded });
    }
    throw error instanceof JevClientError
      ? error
      : new JevClientError(error instanceof Error ? error.message : String(error), { noResponse: !responded });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const JEV_MODEL = 'jev-latest';

/** A question as the API accepts it: `score` carries an ordered criteria list. */
type WireQuestion = Omit<JevQuestionDef, 'criteria'> & { criteria: Record<string, string> | string[] };

/**
 * Map authored questions onto the wire schema. Criteria are authored as a
 * named map for readability, but `score` questions are rejected with HTTP 422
 * (`Input should be a valid list`) unless the criteria are an ordered list of
 * descriptions from low to high; the answer legend then comes back keyed by
 * index. `choice` and `noul` take the map unchanged.
 */
export function serializeQuestions(questions: JevQuestions): Record<string, WireQuestion> {
  const out: Record<string, WireQuestion> = {};
  for (const [name, question] of Object.entries(questions)) {
    out[name] = question.type === 'score'
      ? { ...question, criteria: Object.values(question.criteria) }
      : question;
  }
  return out;
}

/**
 * Minimal response validation: object with a non-empty `answers` dict whose
 * entries are objects with a string `type`. Throws JevClientError otherwise.
 */
export function validateJevResponse(body: unknown): JevResponse {
  if (body === null || typeof body !== 'object') {
    throw new JevClientError('invalid response: expected object');
  }
  const { answers } = body as { answers?: unknown };
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) {
    throw new JevClientError('invalid response: missing answers object');
  }
  const entries = Object.entries(answers as Record<string, unknown>);
  if (entries.length === 0) {
    throw new JevClientError('invalid response: answers is empty');
  }
  for (const [name, answer] of entries) {
    if (answer === null || typeof answer !== 'object' || typeof (answer as { type?: unknown }).type !== 'string') {
      throw new JevClientError(`invalid response: answer "${name}" has no string type`);
    }
  }
  return body as JevResponse;
}

/** A Noul probability at or above this value reads as "yes". */
export const NOUL_YES_THRESHOLD = 0.5;

/**
 * Read a Noul answer as yes/no. The API returns `noul` as the probability of
 * "yes" (0-1), not as a boolean, so `noul === true` never matches a real
 * answer. A boolean is still accepted; a missing or non-finite value reads as
 * "no". Same rule as jevSaysTaskComplete() in scripts/persistent-mode.mjs.
 */
export function noulAnswerIsYes(answer: JevAnswer | undefined): boolean {
  const noul = answer?.noul;
  if (typeof noul === 'boolean') return noul;
  return typeof noul === 'number' && Number.isFinite(noul) && noul >= NOUL_YES_THRESHOLD;
}
