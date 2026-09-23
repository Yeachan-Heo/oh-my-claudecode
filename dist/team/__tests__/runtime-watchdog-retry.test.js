import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { atomicWriteJson } from '../../lib/atomic-write.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import { DEFAULT_MAX_TASK_RETRIES, isTaskRetryExhausted, readTaskFailure, writeTaskFailure, } from '../task-file-ops.js';
/**
 * These tests retain task-file primitives only. The v1 lifecycle contracts
 * formerly exercised here—automatic pane-dead retries, retry warning text,
 * low-index scheduling, and watchdog stop/timer quiescence—are retired.
 */
describe('task failure sidecar counter primitive', () => {
    let cwd;
    let previousHome;
    let previousUserProfile;
    let previousStateDir;
    beforeEach(() => {
        cwd = mkdtempSync(join(tmpdir(), 'runtime-task-failure-counter-'));
        previousHome = process.env.HOME;
        previousUserProfile = process.env.USERPROFILE;
        previousStateDir = process.env.OMC_STATE_DIR;
        process.env.HOME = cwd;
        process.env.USERPROFILE = cwd;
        delete process.env.OMC_STATE_DIR;
    });
    afterEach(() => {
        if (previousHome === undefined)
            delete process.env.HOME;
        else
            process.env.HOME = previousHome;
        if (previousUserProfile === undefined)
            delete process.env.USERPROFILE;
        else
            process.env.USERPROFILE = previousUserProfile;
        if (previousStateDir === undefined)
            delete process.env.OMC_STATE_DIR;
        else
            process.env.OMC_STATE_DIR = previousStateDir;
        rmSync(cwd, { recursive: true, force: true });
    });
    it('tracks the explicit five-attempt budget without mutating the task or scheduling a retry', () => {
        const teamName = 'task-failure-counter';
        const taskPath = seedTask(cwd, teamName, {
            status: 'in_progress',
            owner: 'worker-1',
        });
        const originalTask = readFileSync(taskPath, 'utf8');
        for (let attempt = 1; attempt < DEFAULT_MAX_TASK_RETRIES; attempt += 1) {
            const sidecar = writeTaskFailure(teamName, '1', `provider failure ${attempt}`, { cwd });
            expect(sidecar.retryCount).toBe(attempt);
            expect(readFileSync(taskPath, 'utf8')).toBe(originalTask);
            expect(isTaskRetryExhausted(teamName, '1', DEFAULT_MAX_TASK_RETRIES, { cwd })).toBe(false);
        }
        const terminalSidecar = writeTaskFailure(teamName, '1', 'final provider failure', { cwd });
        expect(terminalSidecar.retryCount).toBe(DEFAULT_MAX_TASK_RETRIES);
        expect(isTaskRetryExhausted(teamName, '1', DEFAULT_MAX_TASK_RETRIES, { cwd })).toBe(true);
        expect(isTaskRetryExhausted(teamName, '1', DEFAULT_MAX_TASK_RETRIES + 1, { cwd })).toBe(false);
        expect(readTaskFailure(teamName, '1', { cwd })).toEqual(terminalSidecar);
        expect(readFileSync(taskPath, 'utf8')).toBe(originalTask);
    });
});
describe('atomic task JSON publication', () => {
    let cwd;
    let previousHome;
    let previousUserProfile;
    let previousStateDir;
    beforeEach(() => {
        cwd = mkdtempSync(join(tmpdir(), 'runtime-task-atomic-publication-'));
        previousHome = process.env.HOME;
        previousUserProfile = process.env.USERPROFILE;
        previousStateDir = process.env.OMC_STATE_DIR;
        process.env.HOME = cwd;
        process.env.USERPROFILE = cwd;
        delete process.env.OMC_STATE_DIR;
    });
    afterEach(() => {
        if (previousHome === undefined)
            delete process.env.HOME;
        else
            process.env.HOME = previousHome;
        if (previousUserProfile === undefined)
            delete process.env.USERPROFILE;
        else
            process.env.USERPROFILE = previousUserProfile;
        if (previousStateDir === undefined)
            delete process.env.OMC_STATE_DIR;
        else
            process.env.OMC_STATE_DIR = previousStateDir;
        rmSync(cwd, { recursive: true, force: true });
    });
    it('keeps the previous task bytes visible until the atomic rename boundary', async () => {
        const teamName = 'task-atomic-publication';
        const taskPath = seedTask(cwd, teamName, {
            status: 'pending',
            owner: 'worker-1',
        });
        const oldBytes = readFileSync(taskPath, 'utf8');
        const nextTask = {
            ...JSON.parse(oldBytes),
            status: 'in_progress',
            claimedBy: 'worker-1',
            claimedAt: Date.now(),
        };
        let bytesBeforeRename = '';
        await atomicWriteJson(taskPath, nextTask, {
            beforeRename: () => {
                bytesBeforeRename = readFileSync(taskPath, 'utf8');
            },
        });
        expect(bytesBeforeRename).toBe(oldBytes);
        expect(readFileSync(taskPath, 'utf8')).toBe(JSON.stringify(nextTask, null, 2));
        expect(readdirSync(join(getOmcRoot(cwd), 'state', 'team', teamName, 'tasks'))
            .filter(name => name.includes('.tmp')).length).toBe(0);
    });
    it('keeps the historical direct-target truncation hazard as an isolated baseline', () => {
        const targetPath = join(cwd, 'historical-direct-write-task.json');
        const original = JSON.stringify({ status: 'pending', owner: 'worker-1' });
        writeFileSync(targetPath, original, 'utf8');
        // This is deliberately unsafe historical behavior, not a production writer.
        writeFileSync(targetPath, '', 'utf8');
        expect(() => JSON.parse(readFileSync(targetPath, 'utf8'))).toThrow(SyntaxError);
        writeFileSync(targetPath, original, 'utf8');
        expect(readFileSync(targetPath, 'utf8')).toBe(original);
    });
});
function seedTask(cwd, teamName, overrides) {
    const tasksDir = join(getOmcRoot(cwd), 'state', 'team', teamName, 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    const task = {
        id: '1',
        subject: 'Task 1',
        description: 'Do work',
        status: 'pending',
        owner: 'worker-1',
        blocks: [],
        blockedBy: [],
        ...overrides,
    };
    const taskPath = join(tasksDir, 'task-1.json');
    writeFileSync(taskPath, JSON.stringify(task, null, 2), 'utf8');
    return taskPath;
}
//# sourceMappingURL=runtime-watchdog-retry.test.js.map