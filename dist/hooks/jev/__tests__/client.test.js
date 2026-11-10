import { describe, expect, it } from 'vitest';
import { JEV_MODEL, JevClientError, queryJev } from '../client.js';
const QUESTIONS = {
    trigger: { type: 'choice', criteria: { ralph: 'persistent loop', tdd: 'test first' } },
};
function okResponse(body) {
    return { ok: true, status: 200, json: async () => body };
}
function captureFetch(handler) {
    const calls = [];
    const fetchFn = (async (url, init) => {
        calls.push({ url: url, init: init });
        return handler();
    });
    return { fetchFn, calls };
}
describe('question serialization (#4091)', () => {
    it('sends score criteria as the ordered list the API requires', async () => {
        const scoreQuestions = {
            staleness: {
                type: 'score',
                criteria: { fresh: 'Fresh — keep', aging: 'Aging', stale: 'Stale — prune candidate' },
            },
        };
        const { fetchFn, calls } = captureFetch(() => okResponse({ answers: { staleness: { type: 'score', score: 2 } } }));
        await queryJev({}, scoreQuestions, {
            endpoint: 'https://stub.example',
            apiKey: 'k',
            timeoutMs: 250,
            fetchFn,
        });
        const body = JSON.parse(calls[0].init?.body);
        expect(body.questions.staleness.criteria).toEqual(['Fresh — keep', 'Aging', 'Stale — prune candidate']);
    });
    it('leaves choice and noul criteria as the named map', async () => {
        const questions = {
            intent: { type: 'noul', criteria: { true: 'yes', false: 'no' } },
        };
        const { fetchFn, calls } = captureFetch(() => okResponse({ answers: { intent: { type: 'noul', noul: true } } }));
        await queryJev({}, questions, {
            endpoint: 'https://stub.example',
            apiKey: 'k',
            timeoutMs: 250,
            fetchFn,
        });
        const body = JSON.parse(calls[0].init?.body);
        expect(body.questions.intent.criteria).toEqual({ true: 'yes', false: 'no' });
        expect(body.questions.intent.type).toBe('noul');
    });
});
describe('queryJev', () => {
    it('POSTs state, questions and model with bearer auth to the endpoint', async () => {
        const { fetchFn, calls } = captureFetch(() => okResponse({ answers: { trigger: { type: 'choice', choice: 'ralph', confidence: 0.9 } } }));
        const response = await queryJev({ q: 'x' }, QUESTIONS, {
            endpoint: 'https://stub.example/v1/systemone',
            apiKey: 'test-key',
            timeoutMs: 250,
            fetchFn,
        });
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://stub.example/v1/systemone');
        expect(calls[0].init?.method).toBe('POST');
        const headers = calls[0].init?.headers;
        expect(headers.Authorization).toBe('Bearer test-key');
        expect(headers['Content-Type']).toBe('application/json');
        expect(JSON.parse(calls[0].init?.body)).toEqual({
            state: { q: 'x' },
            questions: QUESTIONS,
            model: JEV_MODEL,
        });
        expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
        expect(response.answers.trigger.choice).toBe('ralph');
        expect(response.answers.trigger.confidence).toBe(0.9);
    });
    it('throws JevClientError on HTTP error status', async () => {
        const { fetchFn } = captureFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
        await expect(queryJev({}, QUESTIONS, { endpoint: 'https://stub.example', apiKey: 'k', timeoutMs: 250, fetchFn })).rejects.toThrow(JevClientError);
    });
    it('throws JevClientError when answers is missing or empty', async () => {
        for (const body of [{}, { answers: {} }, { answers: 'nope' }]) {
            const { fetchFn } = captureFetch(() => okResponse(body));
            await expect(queryJev({}, QUESTIONS, { endpoint: 'https://stub.example', apiKey: 'k', timeoutMs: 250, fetchFn })).rejects.toThrow(JevClientError);
        }
    });
    it('throws JevClientError when an answer has no string type', async () => {
        const { fetchFn } = captureFetch(() => okResponse({ answers: { trigger: { choice: 'x' } } }));
        await expect(queryJev({}, QUESTIONS, { endpoint: 'https://stub.example', apiKey: 'k', timeoutMs: 25, fetchFn })).rejects.toThrow(JevClientError);
    });
    it('times out when the transport never responds', async () => {
        const fetchFn = (async () => new Promise(() => { }));
        await expect(queryJev({}, QUESTIONS, { endpoint: 'https://stub.example', apiKey: 'k', timeoutMs: 20, fetchFn })).rejects.toThrow(/timed out/);
    });
    it('aborts the underlying request via the AbortController signal', async () => {
        let aborted = false;
        const fetchFn = (async (_url, init) => {
            const signal = init.signal;
            return new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => {
                    aborted = true;
                    reject(new Error('The operation was aborted'));
                });
            });
        });
        await expect(queryJev({}, QUESTIONS, { endpoint: 'https://stub.example', apiKey: 'k', timeoutMs: 20, fetchFn })).rejects.toThrow(JevClientError);
        expect(aborted).toBe(true);
    });
    it('maps non-Error transport failures to JevClientError', async () => {
        const fetchFn = (async () => {
            throw 'boom';
        });
        await expect(queryJev({}, QUESTIONS, { endpoint: 'https://stub.example', apiKey: 'k', timeoutMs: 250, fetchFn })).rejects.toThrow(JevClientError);
    });
});
//# sourceMappingURL=client.test.js.map