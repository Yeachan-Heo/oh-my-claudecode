/**
 * The TS resolver and the opt-in breaker and request limit it shares with the
 * hook scripts (scripts/lib/jev-breaker.mjs): same state, same classification,
 * no change without OMC_JEV_BREAKER / OMC_JEV_MAX_RPM.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JevClientError, queryJev } from '../client.js';
import { resetJevResolverState, resolveJudgment } from '../resolver.js';
const ENV_KEYS = [
    'TYPESAFE_API_KEY',
    'OMC_JEV',
    'OMC_JEV_TIMEOUT_MS',
    'OMC_JEV_MAX_REQUESTS',
    'OMC_JEV_LOG_DIR',
    'OMC_JEV_ENDPOINT',
    'OMC_JEV_BREAKER',
    'OMC_JEV_MAX_RPM',
    'OMC_JEV_BREAKER_DIR',
];
const QUESTIONS = {
    route: { type: 'choice', criteria: { haiku: 'simple', sonnet: 'standard', opus: 'complex' } },
};
const TWIN = 'sonnet';
let dir = '';
const savedEnv = {};
beforeEach(async () => {
    resetJevResolverState();
    dir = await mkdtemp(join(tmpdir(), 'jev-shared-breaker-'));
    for (const key of ENV_KEYS) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
    }
    process.env.TYPESAFE_API_KEY = 'test-key';
    process.env.OMC_JEV = 'model-routing';
    process.env.OMC_JEV_LOG_DIR = join(dir, 'log');
    process.env.OMC_JEV_BREAKER_DIR = join(dir, 'breaker');
    process.env.OMC_JEV_ENDPOINT = 'http://127.0.0.1:9/v1/systemone';
});
afterEach(async () => {
    for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined)
            delete process.env[key];
        else
            process.env[key] = savedEnv[key];
    }
    await rm(dir, { recursive: true, force: true });
});
function ok() {
    return { ok: true, status: 200, json: async () => ({ answers: { route: { type: 'choice', choice: 'opus' } } }) };
}
function failed(status, retryAfter) {
    return {
        ok: false,
        status,
        headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? retryAfter ?? null : null) },
        json: async () => {
            throw new Error('the body of a failed response must not be read');
        },
    };
}
function counting(handler) {
    let n = 0;
    const fetchFn = (async () => {
        n += 1;
        return handler(n);
    });
    return { fetchFn, count: () => n };
}
function judge(fetchFn) {
    return resolveJudgment({ point: 'model-routing', state: { task: 'x' }, questions: QUESTIONS, twin: () => TWIN, fetchFn });
}
function rows() {
    const path = join(dir, 'log', 'shadow.jsonl');
    return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
}
describe('JevClientError failure details', () => {
    it('carries status and Retry-After of an HTTP error', async () => {
        const error = await queryJev({}, QUESTIONS, { endpoint: 'x', apiKey: 'k', timeoutMs: 1000, fetchFn: async () => failed(429, '42') })
            .catch((caught) => caught);
        expect(error).toBeInstanceOf(JevClientError);
        expect(error).toMatchObject({ status: 429, retryAfter: '42' });
        expect(error.noResponse).toBeFalsy();
    });
    it('marks a network error and a timeout as no response, an invalid body not', async () => {
        const network = await queryJev({}, QUESTIONS, {
            endpoint: 'x', apiKey: 'k', timeoutMs: 1000, fetchFn: (async () => { throw new TypeError('fetch failed'); }),
        }).catch((caught) => caught);
        expect(network).toMatchObject({ noResponse: true, status: undefined });
        const timeout = await queryJev({}, QUESTIONS, {
            endpoint: 'x', apiKey: 'k', timeoutMs: 20, fetchFn: (() => new Promise(() => { })),
        }).catch((caught) => caught);
        expect(timeout).toMatchObject({ noResponse: true });
        expect(timeout.message).toContain('timed out');
        const invalid = await queryJev({}, QUESTIONS, {
            endpoint: 'x', apiKey: 'k', timeoutMs: 1000, fetchFn: (async () => ({ ok: true, status: 200, json: async () => ({}) })),
        }).catch((caught) => caught);
        expect(invalid).toBeInstanceOf(JevClientError);
        expect(invalid.noResponse).toBeFalsy();
        expect(invalid.status).toBeUndefined();
    });
});
describe('resolveJudgment with the shared breaker', () => {
    it('without the variables a 429 opens nothing shared and writes no state', async () => {
        const { fetchFn, count } = counting(() => failed(429, '120'));
        expect((await judge(fetchFn)).mode).toBe('degraded');
        expect((await judge(fetchFn)).mode).toBe('degraded');
        expect(count()).toBe(2);
        expect(existsSync(join(dir, 'breaker'))).toBe(false);
    });
    it('OMC_JEV_BREAKER=1: a 429 opens it, the next call returns the twin as circuit-open without a fetch and logs it', async () => {
        process.env.OMC_JEV_BREAKER = '1';
        const { fetchFn, count } = counting(() => failed(429, '120'));
        expect((await judge(fetchFn)).mode).toBe('degraded');
        const held = await judge(fetchFn);
        expect(held).toEqual({ answer: TWIN, source: 'twin', mode: 'circuit-open' });
        expect(count()).toBe(1);
        const last = rows().pop();
        expect(last).toMatchObject({ point: 'model-routing', mode: 'circuit-open', reason: 'http-429', jev: null, answers: null, heuristic: TWIN });
        expect(typeof last?.until).toBe('string');
    });
    it('a 429 without a usable Retry-After takes the retry time from its body; the header wins; without the breaker no body is read', async () => {
        const withBody = (status, text, retryAfter) => {
            const response = failed(status, retryAfter);
            response.reads = 0;
            response.text = async () => {
                response.reads += 1;
                return text;
            };
            return response;
        };
        const openFor = async (response) => {
            resetJevResolverState();
            const before = Date.now();
            const { fetchFn } = counting(() => response);
            await judge(fetchFn);
            const state = JSON.parse(readFileSync(join(dir, 'breaker', readdirSync(join(dir, 'breaker'))[0], 'breaker.json'), 'utf8'));
            return Math.round((state.until - before) / 1000);
        };
        process.env.OMC_JEV_BREAKER = '1';
        expect(await openFor(withBody(429, 'Rate limited. Retry after ~45s'))).toBe(45);
        await rm(join(dir, 'breaker'), { recursive: true, force: true });
        const withHeader = withBody(429, 'retry after ~45s', '20');
        expect(await openFor(withHeader)).toBe(20);
        expect(withHeader.reads).toBe(0);
        await rm(join(dir, 'breaker'), { recursive: true, force: true });
        expect(await openFor(failed(429))).toBe(60); // no readable body: the default minute
        await rm(join(dir, 'breaker'), { recursive: true, force: true });
        const server = withBody(503, 'retry after ~45s');
        expect(await openFor(server)).toBe(60);
        expect(server.reads).toBe(0);
        // A real response with a body stream: read as far as the first 2000 characters.
        await rm(join(dir, 'breaker'), { recursive: true, force: true });
        expect(await openFor(new Response('rate limited, retry after ~45s ' + 'x'.repeat(3_000_000), { status: 429 }))).toBe(45);
        await rm(join(dir, 'breaker'), { recursive: true, force: true });
        expect(await openFor(new Response('x'.repeat(2500) + ' retry after ~45s', { status: 429 }))).toBe(60);
        // A request limit alone does not read a body.
        delete process.env.OMC_JEV_BREAKER;
        process.env.OMC_JEV_MAX_RPM = '100';
        await rm(join(dir, 'breaker'), { recursive: true, force: true });
        const limitOnly = withBody(429, 'retry after ~45s');
        await judge(counting(() => limitOnly).fetchFn);
        expect(limitOnly.reads).toBe(0);
    });
    it('OMC_JEV_MAX_REQUESTS counts calls that run at the same time, with and without the shared breaker', async () => {
        process.env.OMC_JEV_MAX_REQUESTS = '1';
        for (const maxRpm of [undefined, '100']) {
            resetJevResolverState();
            if (maxRpm === undefined)
                delete process.env.OMC_JEV_MAX_RPM;
            else
                process.env.OMC_JEV_MAX_RPM = maxRpm;
            const { fetchFn, count } = counting(() => ok());
            const results = await Promise.all([judge(fetchFn), judge(fetchFn)]);
            expect(count()).toBe(1);
            expect(results.map((result) => result.mode).sort()).toEqual(['cap', 'shadow']);
        }
    });
    it('a call held back by the shared limit takes no slot of OMC_JEV_MAX_REQUESTS', async () => {
        const left = 60_000 - (Date.now() % 60_000);
        if (left < 3000)
            await new Promise((resolve) => setTimeout(resolve, left + 50));
        process.env.OMC_JEV_MAX_REQUESTS = '2';
        process.env.OMC_JEV_MAX_RPM = '1';
        const { fetchFn, count } = counting(() => ok());
        expect((await judge(fetchFn)).mode).toBe('shadow');
        expect((await judge(fetchFn)).mode).toBe('cap'); // the per-minute limit
        expect((await judge(fetchFn)).mode).toBe('cap');
        expect(count()).toBe(1);
        delete process.env.OMC_JEV_MAX_RPM;
        expect((await judge(fetchFn)).mode).toBe('shadow'); // the second slot of OMC_JEV_MAX_REQUESTS is still free
        expect(count()).toBe(2);
    });
    it('OMC_JEV_MAX_RPM=1: the second call of the minute returns the twin as cap', async () => {
        const left = 60_000 - (Date.now() % 60_000);
        if (left < 3000)
            await new Promise((resolve) => setTimeout(resolve, left + 50));
        process.env.OMC_JEV_MAX_RPM = '1';
        const { fetchFn, count } = counting(() => ok());
        expect((await judge(fetchFn)).mode).toBe('shadow');
        expect(await judge(fetchFn)).toEqual({ answer: TWIN, source: 'twin', mode: 'cap' });
        expect(count()).toBe(1);
        expect(rows().pop()).toMatchObject({ mode: 'cap', reason: 'rpm', priority: 'high', rpm: { count: 1, threshold: 1, limit: 1 } });
    });
    it('the in-process circuit still works with the shared breaker on (no-response failures)', async () => {
        process.env.OMC_JEV_BREAKER = '1';
        const { fetchFn, count } = counting(() => {
            throw new TypeError('fetch failed');
        });
        for (let i = 0; i < 3; i += 1)
            expect((await judge(fetchFn)).mode).toBe('degraded');
        // Three failures without a response: both the in-process and the shared breaker are open now.
        expect((await judge(fetchFn)).mode).toBe('circuit-open');
        resetJevResolverState();
        expect((await judge(fetchFn)).mode).toBe('circuit-open');
        expect(count()).toBe(3);
    });
});
//# sourceMappingURL=shared-breaker.test.js.map