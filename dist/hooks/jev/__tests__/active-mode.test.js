/**
 * Jev active mode integration tests (issue #4208).
 *
 * Verify that when OMC_JEV=point:active or OMC_JEV=all:active, each judgment
 * point consumes the Jev answer instead of the heuristic twin, and degrade
 * paths (timeout, HTTP error) fall back to the twin.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetJevResolverState } from '../resolver.js';
import { recordJudgment } from '../points.js';
const ENV_KEYS = [
    'TYPESAFE_API_KEY',
    'OMC_JEV',
    'OMC_JEV_TIMEOUT_MS',
    'OMC_JEV_LOG_DIR',
    'OMC_JEV_ENDPOINT',
];
const QUESTIONS = {
    route: { type: 'choice', criteria: { haiku: 'simple', sonnet: 'standard', opus: 'complex' } },
};
let logDir = '';
const savedEnv = {};
beforeEach(async () => {
    resetJevResolverState();
    logDir = await mkdtemp(join(tmpdir(), 'jev-active-test-'));
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
function jevOk(answer) {
    return {
        ok: true,
        status: 200,
        json: async () => ({ answers: { route: { type: 'choice', ...answer } } }),
    };
}
function captureFetch(handler) {
    const calls = [];
    const fetchFn = (async (url, init) => {
        calls.push({ url: url, init: init });
        return handler();
    });
    return { fetchFn, calls };
}
async function readLog() {
    return readFile(join(logDir, 'shadow.jsonl'), 'utf8');
}
describe('resolver non-blocking active wait', () => {
    it('non-blocking point in active mode waits for Jev answer', async () => {
        process.env.TYPESAFE_API_KEY = 'test-key';
        process.env.OMC_JEV = 'task-size:active';
        const { fetchFn } = captureFetch(() => jevOk({ choice: 'large' }));
        const result = await recordJudgment('task-size', {
            state: { prompt: 'test', source: 'test' },
            twin: () => ({ size: 'small', reason: 'heuristic', wordCount: 10, hasEscapeHatch: false }),
            mapAnswer: (answer) => ({
                size: answer.choice?.toLowerCase() ?? 'medium',
                reason: 'jev',
                wordCount: 0,
                hasEscapeHatch: false,
            }),
            fetchFn,
        });
        // Non-blocking active: should wait for Jev and use answer
        expect(result.mode).toBe('active');
        expect(result.source).toBe('jev');
        expect(result.answer.size).toBe('large');
        // Shadow log should be written
        const line = JSON.parse(await readLog());
        expect(line.mode).toBe('active');
    });
    it('non-blocking active with timeout falls back to twin', async () => {
        process.env.TYPESAFE_API_KEY = 'test-key';
        process.env.OMC_JEV = 'task-size:active';
        process.env.OMC_JEV_TIMEOUT_MS = '20';
        const fetchFn = (async () => new Promise(() => { }));
        const result = await recordJudgment('task-size', {
            state: { prompt: 'test', source: 'test' },
            twin: () => ({ size: 'small', reason: 'heuristic', wordCount: 10, hasEscapeHatch: false }),
            mapAnswer: (answer) => ({
                size: answer.choice?.toLowerCase() ?? 'medium',
                reason: 'jev',
                wordCount: 0,
                hasEscapeHatch: false,
            }),
            fetchFn,
        });
        // Degraded: should fall back to twin
        expect(result.mode).toBe('degraded');
        expect(result.source).toBe('twin');
        expect(result.answer.size).toBe('small');
    });
});
describe('active mode integration', () => {
    it('task-size: active mode uses Jev choice over the heuristic', async () => {
        process.env.TYPESAFE_API_KEY = 'test-key';
        process.env.OMC_JEV = 'task-size:active';
        const { fetchFn } = captureFetch(() => jevOk({ choice: 'large' }));
        const result = await recordJudgment('task-size', {
            state: { prompt: 'a small prompt', source: 'test' },
            twin: () => ({ size: 'small', reason: 'heuristic', wordCount: 10, hasEscapeHatch: false }),
            mapAnswer: (answer) => ({
                size: answer.choice?.toLowerCase() ?? 'medium',
                reason: 'jev-active',
                wordCount: 0,
                hasEscapeHatch: false,
            }),
            fetchFn,
        });
        // Active mode: Jev's 'large' choice should override the 'small' heuristic
        expect(result.mode).toBe('active');
        expect(result.source).toBe('jev');
        expect(result.answer.size).toBe('large');
        expect(result.answer.reason).toBe('jev-active');
        // Log preserves heuristic for comparison
        const line = JSON.parse(await readLog());
        expect(line.mode).toBe('active');
        expect(line.heuristic.size).toBe('small');
        expect(line.jev.choice).toBe('large');
    });
    it('intent: active mode uses Jev noul over the heuristic pattern match', async () => {
        process.env.TYPESAFE_API_KEY = 'test-key';
        process.env.OMC_JEV = 'intent:active';
        const { fetchFn } = captureFetch(() => jevOk({ noul: true }));
        const result = await recordJudgment('intent', {
            state: { prompt: 'not an intent command', mode_name: 'intent' },
            twin: () => false, // Heuristic regex says false
            mapAnswer: (answer) => answer.noul === true,
            fetchFn,
        });
        // Active mode: Jev's noul=true should override the false heuristic
        expect(result.mode).toBe('active');
        expect(result.source).toBe('jev');
        expect(result.answer).toBe(true);
        const line = JSON.parse(await readLog());
        expect(line.mode).toBe('active');
        expect(line.heuristic).toBe(false);
        expect(line.jev.noul).toBe(true);
    });
    it('model-routing: active mode uses Jev choice over the tier heuristic', async () => {
        process.env.TYPESAFE_API_KEY = 'test-key';
        process.env.OMC_JEV = 'model-routing:active';
        const { fetchFn } = captureFetch(() => jevOk({ choice: 'opus' }));
        const result = await recordJudgment('model-routing', {
            state: { tool_name: 'Tool', source: 'test' },
            twin: () => ({ tier: 'sonnet' }), // Heuristic default
            mapAnswer: (answer) => ({ tier: answer.choice || 'sonnet' }),
            fetchFn,
        });
        // Active mode: Jev's 'opus' should override the 'sonnet' heuristic
        expect(result.mode).toBe('active');
        expect(result.source).toBe('jev');
        expect(result.answer.tier).toBe('opus');
    });
    it('context-pruning: active mode uses Jev staleness score over heuristic action', async () => {
        process.env.TYPESAFE_API_KEY = 'test-key';
        process.env.OMC_JEV = 'context-pruning:active';
        const { fetchFn } = captureFetch(() => jevOk({ score: 3, choice: 'stale' }));
        const result = await recordJudgment('context-pruning', {
            state: { action: 'warn', totalTokens: 150000 },
            twin: () => 'warn', // Heuristic says warn
            mapAnswer: (answer) => {
                // Jev says stale -> compact
                const choice = answer.choice?.toLowerCase();
                if (choice === 'stale')
                    return 'compact';
                if (choice === 'aging')
                    return 'warn';
                return 'none';
            },
            fetchFn,
        });
        // Active mode: Jev's 'stale' should override the 'warn' heuristic with 'compact'
        expect(result.mode).toBe('active');
        expect(result.source).toBe('jev');
        expect(result.answer).toBe('compact');
    });
    it('active mode with degrade: timeout falls back to heuristic', async () => {
        process.env.TYPESAFE_API_KEY = 'test-key';
        process.env.OMC_JEV = 'task-size:active';
        process.env.OMC_JEV_TIMEOUT_MS = '20';
        const fetchFn = (async () => new Promise(() => { }));
        const result = await recordJudgment('task-size', {
            state: { prompt: 'test', source: 'test' },
            twin: () => ({ size: 'small', reason: 'heuristic', wordCount: 10, hasEscapeHatch: false }),
            mapAnswer: (answer) => ({
                size: answer.choice?.toLowerCase() ?? 'medium',
                reason: 'jev',
                wordCount: 0,
                hasEscapeHatch: false,
            }),
            fetchFn,
        });
        // Degraded (timeout): falls back to heuristic
        expect(result.mode).toBe('degraded');
        expect(result.source).toBe('twin');
        expect(result.answer.size).toBe('small');
        expect(result.answer.reason).toBe('heuristic');
    });
    it('ralph-verdict: active mode uses Jev noul over heuristic verdict', async () => {
        process.env.TYPESAFE_API_KEY = 'test-key';
        process.env.OMC_JEV = 'ralph-verdict:active';
        const { fetchFn } = captureFetch(() => jevOk({ noul: false }));
        const result = await recordJudgment('ralph-verdict', {
            state: { verdict: true, prd_criteria: 'test', claim: 'all done' },
            twin: () => true, // Heuristic says approved
            mapAnswer: (answer) => answer.noul === true,
            fetchFn,
        });
        // Active mode: Jev's noul=false should override the true heuristic
        expect(result.mode).toBe('active');
        expect(result.source).toBe('jev');
        expect(result.answer).toBe(false);
    });
    it('loop-continuation: active mode uses Jev completion noul over heuristic', async () => {
        process.env.TYPESAFE_API_KEY = 'test-key';
        process.env.OMC_JEV = 'loop-continuation:active';
        const { fetchFn } = captureFetch(() => jevOk({ noul: true }));
        const result = await recordJudgment('loop-continuation', {
            state: { mode_name: 'ralph', should_block: true },
            twin: () => ({ shouldBlock: true, message: 'continue', mode: 'ralph' }),
            mapAnswer: (answer) => {
                // If Jev says complete, don't block
                if (answer.noul === true) {
                    return { shouldBlock: false, message: '[jev] complete', mode: 'ralph' };
                }
                return { shouldBlock: true, message: 'continue', mode: 'ralph' };
            },
            fetchFn,
        });
        // Active mode: Jev's noul=true should trigger shouldBlock=false
        expect(result.mode).toBe('active');
        expect(result.source).toBe('jev');
        expect(result.answer.shouldBlock).toBe(false);
        expect(result.answer.message).toBe('[jev] complete');
    });
});
//# sourceMappingURL=active-mode.test.js.map