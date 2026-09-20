/**
 * Zero-dependency Jev client (TypeSafe System One).
 *
 * POSTs {state, questions, model:"jev-latest"} with bearer auth and an
 * AbortController timeout. No retry — the interactive path degrades instead.
 * Throws JevClientError on any failure; the resolver catches and degrades.
 */

import type { JevQuestions, JevResponse } from './types.js';

export class JevClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JevClientError';
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
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new JevClientError(`jev request timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
  });
  try {
    const response = await Promise.race([fetchFn(options.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({ state, questions, model: JEV_MODEL }),
      signal: controller.signal,
    }), timeoutPromise]);
    if (!response.ok) {
      throw new JevClientError(`jev request failed: HTTP ${response.status}`);
    }
    const body: unknown = await response.json();
    return validateJevResponse(body);
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof JevClientError)) {
      throw new JevClientError(`jev request timed out after ${options.timeoutMs}ms`);
    }
    throw error instanceof JevClientError ? error : new JevClientError(error instanceof Error ? error.message : String(error));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const JEV_MODEL = 'jev-latest';

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
