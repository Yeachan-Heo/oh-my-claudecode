import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import { generateUsageReport, recordTaskUsage } from '../usage-tracker.js';
describe('usage JSONL record recovery', () => {
    let root;
    let previous;
    const valid = {
        taskId: 'task-1', workerName: 'worker-1', provider: 'codex', model: 'model-1',
        startedAt: '2026-10-10T00:00:00Z', completedAt: '2026-10-10T00:00:01Z',
        wallClockMs: 1000.5, promptChars: 3, responseChars: 7,
    };
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'omc-usage-shape-'));
        previous = process.env.OMC_STATE_DIR;
        process.env.OMC_STATE_DIR = join(root, 'private-state');
    });
    afterEach(() => {
        if (previous === undefined)
            delete process.env.OMC_STATE_DIR;
        else
            process.env.OMC_STATE_DIR = previous;
        rmSync(root, { recursive: true, force: true });
    });
    it('skips malformed shapes and counts while retaining valid surrounding records', () => {
        recordTaskUsage(root, 'shape', valid);
        const log = join(getOmcRoot(root), 'logs', 'team-usage-shape.jsonl');
        const malformed = [null, [], 12, 'text', {}, { ...valid, provider: 'other' }];
        for (const field of Object.keys(valid)) {
            const missing = { ...valid };
            delete missing[field];
            malformed.push(missing);
        }
        for (const field of ['taskId', 'workerName', 'model', 'startedAt', 'completedAt']) {
            malformed.push({ ...valid, [field]: 42 });
        }
        for (const field of ['wallClockMs', 'promptChars', 'responseChars']) {
            for (const value of [null, '5', -1])
                malformed.push({ ...valid, [field]: value });
        }
        malformed.push({ ...valid, promptChars: 0.5 }, { ...valid, responseChars: 0.5 });
        appendFileSync(log, malformed.map(value => JSON.stringify(value)).join('\n') + '\n');
        appendFileSync(log, JSON.stringify(valid).replace('1000.5', '1e999') + '\n{broken\n');
        recordTaskUsage(root, 'shape', { ...valid, taskId: 'task-2' });
        const bytes = readFileSync(log);
        expect(generateUsageReport(root, 'shape')).toEqual({
            teamName: 'shape', taskCount: 2, totalWallClockMs: 2001,
            workers: [{ workerName: 'worker-1', provider: 'codex', model: 'model-1', taskCount: 2,
                    totalWallClockMs: 2001, totalPromptChars: 6, totalResponseChars: 14 }],
        });
        expect(readFileSync(log)).toEqual(bytes);
    });
    it('retains records with an empty model for provider defaults', () => {
        recordTaskUsage(root, 'default-model', { ...valid, model: '' });
        const report = generateUsageReport(root, 'default-model');
        expect(report.taskCount).toBe(1);
        expect(report.workers[0].model).toBe('');
    });
    it('retains ordinary fractional durations when floating-point sums round normally', () => {
        recordTaskUsage(root, 'fractional', { ...valid, wallClockMs: 0.1 });
        recordTaskUsage(root, 'fractional', { ...valid, taskId: 'task-2', wallClockMs: 0.2 });
        const report = generateUsageReport(root, 'fractional');
        expect(report.taskCount).toBe(2);
        expect(report.totalWallClockMs).toBe(0.3);
        expect(report.workers[0].totalWallClockMs).toBe(0.3);
    });
    it('retains ordinary decimal durations with different fractional precision', () => {
        recordTaskUsage(root, 'decimal', { ...valid, wallClockMs: 0.01 });
        recordTaskUsage(root, 'decimal', { ...valid, taskId: 'task-2', wallClockMs: 0.1 });
        const report = generateUsageReport(root, 'decimal');
        expect(report.taskCount).toBe(2);
        expect(report.totalWallClockMs).toBe(0.11);
        expect(report.workers[0].totalWallClockMs).toBe(0.11);
    });
    it('retains zero-duration records after a rounded subtotal', () => {
        recordTaskUsage(root, 'zero-after-rounding', { ...valid, wallClockMs: 0.30000000000000004 });
        recordTaskUsage(root, 'zero-after-rounding', { ...valid, taskId: 'task-2', wallClockMs: 0.2 });
        recordTaskUsage(root, 'zero-after-rounding', {
            ...valid, taskId: 'zero-duration', wallClockMs: 0, promptChars: 5, responseChars: 6,
        });
        const report = generateUsageReport(root, 'zero-after-rounding');
        expect(report.taskCount).toBe(3);
        expect(report.totalWallClockMs).toBe(0.5);
        expect(report.workers[0].totalWallClockMs).toBe(0.5);
        expect(report.workers[0].totalPromptChars).toBe(11);
        expect(report.workers[0].totalResponseChars).toBe(20);
    });
    it('retains positive increments after a rounded subtotal', () => {
        recordTaskUsage(root, 'positive-after-rounding', { ...valid, wallClockMs: 300000.01 });
        recordTaskUsage(root, 'positive-after-rounding', {
            ...valid, taskId: 'task-2', wallClockMs: 200000.00000000003,
        });
        recordTaskUsage(root, 'positive-after-rounding', {
            ...valid, taskId: 'task-3', wallClockMs: 1, promptChars: 5, responseChars: 6,
        });
        const report = generateUsageReport(root, 'positive-after-rounding');
        expect(report.taskCount).toBe(3);
        expect(report.totalWallClockMs).toBe(500001.01);
        expect(report.workers[0].totalWallClockMs).toBe(500001.01);
        expect(report.workers[0].totalPromptChars).toBe(11);
        expect(report.workers[0].totalResponseChars).toBe(20);
    });
    it('retains fractional increments after a rounded subtotal', () => {
        recordTaskUsage(root, 'fractional-after-rounding', { ...valid, wallClockMs: 300000.01 });
        recordTaskUsage(root, 'fractional-after-rounding', {
            ...valid, taskId: 'task-2', wallClockMs: 200000.00000000003,
        });
        recordTaskUsage(root, 'fractional-after-rounding', {
            ...valid, taskId: 'task-3', wallClockMs: 11.240611, promptChars: 5, responseChars: 6,
        });
        const report = generateUsageReport(root, 'fractional-after-rounding');
        expect(report.taskCount).toBe(3);
        expect(report.totalWallClockMs).toBe(500011.25061100005);
        expect(report.workers[0].totalWallClockMs).toBe(500011.25061100005);
        expect(report.workers[0].totalPromptChars).toBe(11);
        expect(report.workers[0].totalResponseChars).toBe(20);
    });
    it('skips finite but unsafe counters and overflow-prone durations without poisoning valid siblings', () => {
        recordTaskUsage(root, 'large', valid);
        const log = join(getOmcRoot(root), 'logs', 'team-usage-large.jsonl');
        for (const field of ['wallClockMs', 'promptChars', 'responseChars']) {
            const record = { ...valid, [field]: 1e308 };
            appendFileSync(log, JSON.stringify(record) + '\n' + JSON.stringify(record) + '\n');
        }
        recordTaskUsage(root, 'large', { ...valid, taskId: 'task-2' });
        const bytes = readFileSync(log);
        const report = generateUsageReport(root, 'large');
        expect(report.taskCount).toBe(2);
        expect(report.totalWallClockMs).toBe(2001);
        expect(report.workers[0].totalPromptChars).toBe(6);
        expect(report.workers[0].totalResponseChars).toBe(14);
        expect(readFileSync(log)).toEqual(bytes);
    });
    it('skips an addition that would lose safe counter precision while retaining later valid workers', () => {
        recordTaskUsage(root, 'sum', { ...valid, promptChars: Number.MAX_SAFE_INTEGER, responseChars: 0 });
        recordTaskUsage(root, 'sum', { ...valid, promptChars: 1, responseChars: 0 });
        recordTaskUsage(root, 'sum', { ...valid, workerName: 'worker-2' });
        const report = generateUsageReport(root, 'sum');
        expect(report.taskCount).toBe(2);
        expect(report.workers[0].totalPromptChars).toBe(Number.MAX_SAFE_INTEGER);
        expect(report.workers[1].totalPromptChars).toBe(3);
        expect(report.totalWallClockMs).toBe(2001);
    });
    it('skips duration additions beyond the safe aggregate range while retaining later records', () => {
        recordTaskUsage(root, 'duration', {
            ...valid, workerName: 'worker-1', wallClockMs: Number.MAX_SAFE_INTEGER, promptChars: 0, responseChars: 0,
        });
        for (let task = 0; task < 10; task++) {
            recordTaskUsage(root, 'duration', { ...valid, taskId: `rounded-${task}`, workerName: 'worker-2', wallClockMs: 1 });
        }
        recordTaskUsage(root, 'duration', {
            ...valid, taskId: 'later', workerName: 'worker-3', wallClockMs: 0, promptChars: 2, responseChars: 3,
        });
        const report = generateUsageReport(root, 'duration');
        expect(report.taskCount).toBe(2);
        expect(report.totalWallClockMs).toBe(Number.MAX_SAFE_INTEGER);
        expect(report.workers.map(worker => worker.workerName)).toEqual(['worker-1', 'worker-3']);
        expect(report.workers[1].totalPromptChars).toBe(2);
    });
    it('retains exact fractional totals when the Number projection rounds the increment', () => {
        recordTaskUsage(root, 'rounded', {
            ...valid, workerName: 'worker-1', wallClockMs: Number.MAX_SAFE_INTEGER - 1, promptChars: 0, responseChars: 0,
        });
        recordTaskUsage(root, 'rounded', { ...valid, taskId: 'overstated', wallClockMs: 0.75 });
        const report = generateUsageReport(root, 'rounded');
        expect(report.taskCount).toBe(2);
        expect(report.totalWallClockMs).toBe(Number.MAX_SAFE_INTEGER);
        expect(report.workers.map(worker => worker.workerName)).toEqual(['worker-1']);
        expect(report.workers[0].taskCount).toBe(2);
        expect(report.workers[0].totalWallClockMs).toBe(Number.MAX_SAFE_INTEGER);
    });
    it('retains prior fractional durations while bounding later totals', () => {
        recordTaskUsage(root, 'prior-total', {
            ...valid, workerName: 'worker-1', wallClockMs: 0.25, promptChars: 0, responseChars: 0,
        });
        recordTaskUsage(root, 'prior-total', {
            ...valid, taskId: 'lost-prior-total', workerName: 'worker-1',
            wallClockMs: Number.MAX_SAFE_INTEGER - 1, promptChars: 0, responseChars: 0,
        });
        recordTaskUsage(root, 'prior-total', {
            ...valid, taskId: 'later', workerName: 'worker-3', wallClockMs: 0.5, promptChars: 2, responseChars: 3,
        });
        const report = generateUsageReport(root, 'prior-total');
        expect(report.taskCount).toBe(3);
        expect(report.totalWallClockMs).toBe(Number.MAX_SAFE_INTEGER);
        expect(report.workers.map(worker => worker.workerName)).toEqual(['worker-1', 'worker-3']);
        expect(report.workers[0].taskCount).toBe(2);
        expect(report.workers[0].totalWallClockMs).toBe(Number.MAX_SAFE_INTEGER - 1);
        expect(report.workers[1].totalWallClockMs).toBe(0.5);
    });
    it('returns an empty report when every syntactically valid record is invalid', () => {
        recordTaskUsage(root, 'empty', valid);
        const log = join(getOmcRoot(root), 'logs', 'team-usage-empty.jsonl');
        writeFileSync(log, 'null\n{}\n[]\n');
        expect(generateUsageReport(root, 'empty')).toEqual({
            teamName: 'empty', taskCount: 0, totalWallClockMs: 0, workers: [],
        });
    });
});
//# sourceMappingURL=usage-record-shape.test.js.map