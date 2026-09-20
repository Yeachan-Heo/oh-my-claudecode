import { describe, expect, it } from 'vitest';
import { JEV_MODEL, JevClientError, queryJev } from '../client.js';
import type { JevQuestions } from '../types.js';

const QUESTIONS: JevQuestions = {
  trigger: { type: 'Choice', criteria: { ralph: 'persistent loop', tdd: 'test first' } },
};

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

interface CapturedCall {
  url: string;
  init?: RequestInit;
}

function captureFetch(handler: () => Response): { fetchFn: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchFn = (async (url: unknown, init?: unknown) => {
    calls.push({ url: url as string, init: init as RequestInit });
    return handler();
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe('queryJev', () => {
  it('POSTs state, questions and model with bearer auth to the endpoint', async () => {
    const { fetchFn, calls } = captureFetch(() =>
      okResponse({ answers: { trigger: { type: 'Choice', choice: 'ralph', confidence: 0.9 } } }),
    );
    const response = await queryJev({ q: 'x' }, QUESTIONS, {
      endpoint: 'https://stub.example/v1/systemone',
      apiKey: 'test-key',
      timeoutMs: 250,
      fetchFn,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://stub.example/v1/systemone');
    expect(calls[0].init?.method).toBe('POST');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      state: { q: 'x' },
      questions: QUESTIONS,
      model: JEV_MODEL,
    });
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
    expect(response.answers.trigger.choice).toBe('ralph');
    expect(response.answers.trigger.confidence).toBe(0.9);
  });

  it('throws JevClientError on HTTP error status', async () => {
    const { fetchFn } = captureFetch(() =>
      ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response,
    );
    await expect(
      queryJev({}, QUESTIONS, { endpoint: 'https://stub.example', apiKey: 'k', timeoutMs: 250, fetchFn }),
    ).rejects.toThrow(JevClientError);
  });

  it('throws JevClientError when answers is missing or empty', async () => {
    for (const body of [{}, { answers: {} }, { answers: 'nope' }]) {
      const { fetchFn } = captureFetch(() => okResponse(body));
      await expect(
        queryJev({}, QUESTIONS, { endpoint: 'https://stub.example', apiKey: 'k', timeoutMs: 250, fetchFn }),
      ).rejects.toThrow(JevClientError);
    }
  });

  it('throws JevClientError when an answer has no string type', async () => {
    const { fetchFn } = captureFetch(() => okResponse({ answers: { trigger: { choice: 'x' } } }));
    await expect(
      queryJev({}, QUESTIONS, { endpoint: 'https://stub.example', apiKey: 'k', timeoutMs: 25, fetchFn }),
    ).rejects.toThrow(JevClientError);
  });

  it('times out when the transport never responds', async () => {
    const fetchFn = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch;
    await expect(
      queryJev({}, QUESTIONS, { endpoint: 'https://stub.example', apiKey: 'k', timeoutMs: 20, fetchFn }),
    ).rejects.toThrow(/timed out/);
  });

  it('aborts the underlying request via the AbortController signal', async () => {
    let aborted = false;
    const fetchFn = (async (_url: unknown, init?: unknown) => {
      const signal = (init as RequestInit).signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('The operation was aborted'));
        });
      });
    }) as unknown as typeof fetch;
    await expect(
      queryJev({}, QUESTIONS, { endpoint: 'https://stub.example', apiKey: 'k', timeoutMs: 20, fetchFn }),
    ).rejects.toThrow(JevClientError);
    expect(aborted).toBe(true);
  });

  it('maps non-Error transport failures to JevClientError', async () => {
    const fetchFn = (async () => {
      throw 'boom';
    }) as unknown as typeof fetch;
    await expect(
      queryJev({}, QUESTIONS, { endpoint: 'https://stub.example', apiKey: 'k', timeoutMs: 250, fetchFn }),
    ).rejects.toThrow(JevClientError);
  });
});
