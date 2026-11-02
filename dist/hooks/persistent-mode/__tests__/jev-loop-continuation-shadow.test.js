import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetJevResolverState } from '../../jev/index.js';
import { applyLoopContinuationShadow } from '../jev-shadow.js';
const ENV_KEYS = [
    'TYPESAFE_API_KEY',
    'OMC_JEV',
    'OMC_JEV_TIMEOUT_MS',
    'OMC_JEV_MAX_REQUESTS',
    'OMC_JEV_EXCERPT_CHARS',
    'OMC_JEV_LOG_DIR',
    'OMC_JEV_ENDPOINT',
];
const TWIN = {
    shouldBlock: true,
    message: '[RALPH - ITERATION 2/10]\nThe task is NOT complete yet. Continue working.',
    mode: 'ralph',
    metadata: { iteration: 2, maxIterations: 10 },
};
let logDir = '';
const savedEnv = {};
beforeEach(async () => {
    resetJevResolverState();
    logDir = await mkdtemp(join(tmpdir(), 'jev-loop-test-'));
    for (const key of ENV_KEYS) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
    }
    process.env.OMC_JEV_LOG_DIR = logDir;
});
afterEach(async () => {
    for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined)
            delete process.env[key];
        else
            process.env[key] = savedEnv[key];
    }
    await rm(logDir, { recursive: true, force: true });
});
function jevResponse(questionName) {
    const answers = questionName === 'iteration_progress'
        ? { iteration_progress: { type: 'score', score: 2, confidence: 0.7 } }
        : { task_complete: { type: 'noul', noul: false, confidence: 0.8 } };
    return { ok: true, status: 200, json: async () => ({ answers }) };
}
function captureFetch(handler) {
    const calls = [];
    const fetchFn = (async (url, init) => {
        const body = init?.body;
        calls.push({ url: url, body });
        return handler(body);
    });
    return { fetchFn, calls };
}
async function readLogLines() {
    const raw = await readFile(join(logDir, 'shadow.jsonl'), 'utf8');
    return raw.split('\n').filter(Boolean);
}
/** Stub transport answering with the single question name from the request. */
function stubFetch() {
    return captureFetch((body) => {
        const { questions } = JSON.parse(body);
        return jevResponse(Object.keys(questions)[0]);
    });
}
describe('applyLoopContinuationShadow', () => {
    it('with a key, one decision records shadow lines containing the twin decision and the Jev Noul/Score', async () => {
        process.env.TYPESAFE_API_KEY = 'test-key-123';
        process.env.OMC_JEV = 'loop-continuation';
        const { fetchFn, calls } = stubFetch();
        const result = await applyLoopContinuationShadow({ result: TWIN, sessionId: 'sess-1', fetchFn });
        // Twin decides: the returned result is the twin, untouched.
        expect(result).toBe(TWIN);
        // One request per question (Noul, Score); state is iteration metadata only.
        expect(calls).toHaveLength(2);
        const bodies = calls.map((call) => JSON.parse(call.body));
        for (const body of bodies) {
            expect(body.state.mode_name).toBe('ralph');
            expect(body.state.session_id).toBe('sess-1');
            expect(body.state.iteration).toBe(2);
            expect(typeof body.state.continuation_excerpt).toBe('string');
            expect(String(body.state.continuation_excerpt).length).toBeLessThanOrEqual(200);
        }
        expect(bodies.map((b) => Object.values(b.questions)[0].type).sort()).toEqual(['noul', 'score']);
        const lines = await readLogLines();
        expect(lines).toHaveLength(2);
        const parsed = lines.map((line) => JSON.parse(line));
        // heuristics are extracted by mapHeuristic: 
        // - noul=!shouldBlock (task complete question)
        // - score=null (no reliable progress data, make non-comparable)
        // logs may be written in any order since both are async (non-blocking points)
        const noulEntry = parsed.find((e) => e.jev?.type === 'noul');
        const scoreEntry = parsed.find((e) => e.jev?.type === 'score');
        expect(noulEntry.point).toBe('loop-continuation');
        expect(noulEntry.mode).toBe('shadow');
        expect(noulEntry.heuristic).toBe(false); // !shouldBlock
        expect(scoreEntry.point).toBe('loop-continuation');
        expect(scoreEntry.mode).toBe('shadow');
        expect(scoreEntry.heuristic).toBeNull(); // No reliable progress data
    });
    it('without a key, zero fetch calls and the twin result is returned unchanged', async () => {
        const { fetchFn, calls } = stubFetch();
        const result = await applyLoopContinuationShadow({ result: TWIN, sessionId: 'sess-1', fetchFn });
        expect(result).toEqual(TWIN);
        expect(calls).toHaveLength(0);
        await expect(readLogLines()).rejects.toThrow();
    });
    it('on Jev timeout the twin decision is returned unchanged (degraded path)', async () => {
        process.env.TYPESAFE_API_KEY = 'test-key-123';
        process.env.OMC_JEV = 'loop-continuation';
        process.env.OMC_JEV_TIMEOUT_MS = '20';
        const fetchFn = (async () => new Promise(() => { }));
        const result = await applyLoopContinuationShadow({ result: TWIN, sessionId: 'sess-1', fetchFn });
        expect(result).toEqual(TWIN);
        const lines = await readLogLines();
        expect(lines).toHaveLength(2);
        const parsed = lines.map((line) => JSON.parse(line));
        // heuristics are extracted by mapHeuristic: [!shouldBlock (noul), null (score)]
        // logs may be written in any order since both are async (non-blocking points)
        // but degraded logs will have jev:null, so we can't use jev.type to distinguish
        // Instead, check that we have the right heuristics regardless of order
        expect(parsed).toHaveLength(2);
        expect(new Set(parsed.map((e) => e.heuristic))).toEqual(new Set([false, null]));
        for (const entry of parsed) {
            expect(entry.mode).toBe('degraded');
            expect(entry.jev).toBeNull();
        }
    });
    it('skips the judgment entirely when no persistent mode is active', async () => {
        process.env.TYPESAFE_API_KEY = 'test-key-123';
        process.env.OMC_JEV = 'loop-continuation';
        const { fetchFn, calls } = stubFetch();
        const none = { shouldBlock: false, message: '', mode: 'none' };
        const result = await applyLoopContinuationShadow({ result: none, sessionId: 'sess-1', fetchFn });
        expect(result).toBe(none);
        expect(calls).toHaveLength(0);
        await expect(readLogLines()).rejects.toThrow();
    });
    it('makes task-complete non-comparable when team pipeline fails/cancels (shouldBlock=false but not task complete)', async () => {
        process.env.TYPESAFE_API_KEY = 'test-key-123';
        process.env.OMC_JEV = 'loop-continuation';
        const { fetchFn, calls } = stubFetch();
        // Team pipeline failure: shouldBlock=false (allow stopping) but task is NOT complete
        const teamFailed = {
            shouldBlock: false,
            message: '[TEAM] Pipeline failed; allowing stop for recovery',
            mode: 'team',
            metadata: { iteration: 3, maxIterations: 10 },
        };
        const result = await applyLoopContinuationShadow({ result: teamFailed, sessionId: 'sess-1', fetchFn });
        expect(result).toEqual(teamFailed);
        expect(calls).toHaveLength(2);
        const lines = await readLogLines();
        expect(lines).toHaveLength(2);
        const parsed = lines.map((line) => JSON.parse(line));
        // When team mode fails/cancels, the noul (task complete) heuristic should be null
        // not !shouldBlock (which would be true), because shouldBlock=false here means
        // "stop for safety" not "task is complete"
        const noulEntry = parsed.find((e) => e.jev?.type === 'noul');
        expect(noulEntry.heuristic).toBeNull();
    });
});
//# sourceMappingURL=jev-loop-continuation-shadow.test.js.map