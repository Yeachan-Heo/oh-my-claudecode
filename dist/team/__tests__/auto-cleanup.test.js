/**
 * Auto-Cleanup Tests for MCP Team Bridge
 *
 * Tests the auto-cleanup detection logic introduced in mcp-team-bridge.ts:
 * when getTeamStatus reports pending === 0 && inProgress === 0, the worker
 * should self-terminate. When inProgress > 0 or pending > 0, it must NOT.
 *
 * Because handleShutdown involves tmux and process teardown, we test the
 * condition that gates it: getTeamStatus().taskSummary reflects the correct
 * counts so the bridge can make the right decision.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getTeamStatus } from '../team-status.js';
import { atomicWriteJson } from '../fs-utils.js';
// ============================================================
// Test fixtures
// ============================================================
const TEST_TEAM = 'test-auto-cleanup';
let TEAMS_DIR;
let TASKS_DIR;
let WORK_DIR;
let tmpClaudeDir;
let originalClaudeConfigDir;
beforeEach(() => {
    const base = join(tmpdir(), `omc-auto-cleanup-${Date.now()}`);
    tmpClaudeDir = join(base, 'claude');
    TEAMS_DIR = join(tmpClaudeDir, 'teams', TEST_TEAM);
    TASKS_DIR = join(tmpClaudeDir, 'tasks', TEST_TEAM);
    WORK_DIR = join(base, 'work');
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tmpClaudeDir;
    mkdirSync(join(TEAMS_DIR, 'outbox'), { recursive: true });
    mkdirSync(TASKS_DIR, { recursive: true });
    mkdirSync(join(WORK_DIR, '.omc', 'state', 'team-bridge', TEST_TEAM), { recursive: true });
    mkdirSync(join(WORK_DIR, '.omc', 'state'), { recursive: true });
});
afterEach(() => {
    if (originalClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
    }
    else {
        process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    }
    rmSync(tmpClaudeDir, { recursive: true, force: true });
    rmSync(WORK_DIR, { recursive: true, force: true });
});
function writeWorkerRegistry(workers) {
    const registryPath = join(WORK_DIR, '.omc', 'state', 'team-mcp-workers.json');
    atomicWriteJson(registryPath, { teamName: TEST_TEAM, workers });
}
function writeTask(task) {
    atomicWriteJson(join(TASKS_DIR, `${task.id}.json`), task);
}
function makeWorker(name) {
    return {
        agentId: `${name}@${TEST_TEAM}`,
        name,
        agentType: 'mcp-codex',
        model: 'test-model',
        joinedAt: Date.now(),
        tmuxPaneId: `omc-team-${TEST_TEAM}-${name}`,
        cwd: WORK_DIR,
        backendType: 'tmux',
        subscriptions: [],
    };
}
function makeTask(id, owner, status, permanentlyFailed) {
    return {
        id,
        subject: `Task ${id}`,
        description: `Description for task ${id}`,
        status,
        owner,
        blocks: [],
        blockedBy: [],
        ...(permanentlyFailed ? { metadata: { permanentlyFailed: true } } : {}),
    };
}
// ============================================================
// Helper: extract the auto-cleanup condition from taskSummary
// This mirrors the exact check in mcp-team-bridge.ts:
//   if (teamStatus.taskSummary.pending === 0 && teamStatus.taskSummary.inProgress === 0)
// ============================================================
function shouldAutoCleanup(teamName, workDir) {
    const status = getTeamStatus(teamName, workDir);
    return status.taskSummary.total > 0 && status.taskSummary.pending === 0 && status.taskSummary.inProgress === 0;
}
// ============================================================
// Tests
// ============================================================
describe('auto-cleanup when all tasks complete', () => {
    it('should trigger shutdown when all tasks are completed', () => {
        writeWorkerRegistry([makeWorker('w1')]);
        writeTask(makeTask('1', 'w1', 'completed'));
        writeTask(makeTask('2', 'w1', 'completed'));
        expect(shouldAutoCleanup(TEST_TEAM, WORK_DIR)).toBe(true);
    });
    it('should NOT trigger shutdown when tasks are still in_progress', () => {
        writeWorkerRegistry([makeWorker('w1')]);
        writeTask(makeTask('1', 'w1', 'completed'));
        writeTask(makeTask('2', 'w1', 'in_progress'));
        expect(shouldAutoCleanup(TEST_TEAM, WORK_DIR)).toBe(false);
    });
    it('should NOT trigger shutdown when there are pending tasks', () => {
        writeWorkerRegistry([makeWorker('w1')]);
        writeTask(makeTask('1', 'w1', 'completed'));
        writeTask(makeTask('2', 'w1', 'pending'));
        expect(shouldAutoCleanup(TEST_TEAM, WORK_DIR)).toBe(false);
    });
    it('should handle mixed completed/failed tasks as all-done', () => {
        // Permanently-failed tasks are stored with status 'completed' + permanentlyFailed flag.
        // The bridge treats them as terminal — no pending or in_progress remains.
        writeWorkerRegistry([makeWorker('w1'), makeWorker('w2')]);
        writeTask(makeTask('1', 'w1', 'completed'));
        writeTask(makeTask('2', 'w1', 'completed', true)); // permanently failed
        writeTask(makeTask('3', 'w2', 'completed'));
        writeTask(makeTask('4', 'w2', 'completed', true)); // permanently failed
        expect(shouldAutoCleanup(TEST_TEAM, WORK_DIR)).toBe(true);
    });
    it('should NOT trigger when one worker is in_progress and another is done', () => {
        // Two workers: w1 done, w2 still executing — cleanup must NOT fire
        writeWorkerRegistry([makeWorker('w1'), makeWorker('w2')]);
        writeTask(makeTask('1', 'w1', 'completed'));
        writeTask(makeTask('2', 'w2', 'in_progress'));
        expect(shouldAutoCleanup(TEST_TEAM, WORK_DIR)).toBe(false);
    });
    it('should NOT trigger when mix of pending and in_progress tasks remain', () => {
        writeWorkerRegistry([makeWorker('w1')]);
        writeTask(makeTask('1', 'w1', 'in_progress'));
        writeTask(makeTask('2', 'w1', 'pending'));
        expect(shouldAutoCleanup(TEST_TEAM, WORK_DIR)).toBe(false);
    });
    it('should trigger on a single completed task with no workers registered', () => {
        // No worker registry — tasks still exist, but none are pending/in_progress
        writeTask(makeTask('1', 'w1', 'completed'));
        expect(shouldAutoCleanup(TEST_TEAM, WORK_DIR)).toBe(true);
    });
    it('taskSummary counts are correct for all-completed scenario', () => {
        writeWorkerRegistry([makeWorker('w1')]);
        writeTask(makeTask('1', 'w1', 'completed'));
        writeTask(makeTask('2', 'w1', 'completed'));
        writeTask(makeTask('3', 'w1', 'completed', true)); // permanently failed
        const status = getTeamStatus(TEST_TEAM, WORK_DIR);
        expect(status.taskSummary.pending).toBe(0);
        expect(status.taskSummary.inProgress).toBe(0);
        expect(status.taskSummary.total).toBe(3);
        // 2 normal completed + 1 permanently failed
        expect(status.taskSummary.completed).toBe(2);
        expect(status.taskSummary.failed).toBe(1);
    });
    it('taskSummary counts are correct when tasks are still running', () => {
        writeWorkerRegistry([makeWorker('w1')]);
        writeTask(makeTask('1', 'w1', 'completed'));
        writeTask(makeTask('2', 'w1', 'in_progress'));
        writeTask(makeTask('3', 'w1', 'pending'));
        const status = getTeamStatus(TEST_TEAM, WORK_DIR);
        expect(status.taskSummary.pending).toBe(1);
        expect(status.taskSummary.inProgress).toBe(1);
        expect(status.taskSummary.total).toBe(3);
    });
    it('should NOT trigger when task list is empty (startup race condition)', () => {
        // worker starts before tasks are assigned, total===0, must not self-terminate
        writeWorkerRegistry([makeWorker('w1')]);
        expect(shouldAutoCleanup(TEST_TEAM, WORK_DIR)).toBe(false);
    });
    it('should trigger when total > 0 and all tasks are completed', () => {
        // Confirm the guard does not block legitimate cleanup when tasks exist and are all done
        writeWorkerRegistry([makeWorker('w1')]);
        writeTask(makeTask('1', 'w1', 'completed'));
        expect(shouldAutoCleanup(TEST_TEAM, WORK_DIR)).toBe(true);
    });
});
//# sourceMappingURL=auto-cleanup.test.js.map