import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, statSync, realpathSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { readTask, updateTask } from '../task-file-ops.js';
import { checkShutdownSignal, writeShutdownSignal } from '../inbox-outbox.js';
import { writeHeartbeat, readHeartbeat } from '../heartbeat.js';
import { sanitizeName } from '../tmux-session.js';
const TEST_TEAM = 'test-bridge-int';
const TASKS_DIR = join(homedir(), '.claude', 'tasks', TEST_TEAM);
const TEAMS_DIR = join(homedir(), '.claude', 'teams', TEST_TEAM);
const WORK_DIR = join(tmpdir(), '__test_bridge_work__');
function writeTask(task) {
    mkdirSync(TASKS_DIR, { recursive: true });
    writeFileSync(join(TASKS_DIR, `${task.id}.json`), JSON.stringify(task, null, 2));
}
function readOutbox() {
    const outboxFile = join(TEAMS_DIR, 'outbox', `worker1.jsonl`);
    if (!existsSync(outboxFile))
        return [];
    return readFileSync(outboxFile, 'utf-8')
        .trim()
        .split('\n')
        .filter(l => l.trim())
        .map(l => JSON.parse(l));
}
function makeConfig(overrides) {
    return {
        teamName: TEST_TEAM,
        workerName: 'worker1',
        provider: 'codex',
        workingDirectory: WORK_DIR,
        pollIntervalMs: 100, // Fast polling for tests
        taskTimeoutMs: 5000,
        maxConsecutiveErrors: 3,
        outboxMaxLines: 100,
        ...overrides,
    };
}
beforeEach(() => {
    mkdirSync(TASKS_DIR, { recursive: true });
    mkdirSync(join(TEAMS_DIR, 'inbox'), { recursive: true });
    mkdirSync(join(TEAMS_DIR, 'outbox'), { recursive: true });
    mkdirSync(join(TEAMS_DIR, 'signals'), { recursive: true });
    mkdirSync(WORK_DIR, { recursive: true });
    mkdirSync(join(WORK_DIR, '.omc', 'state'), { recursive: true });
});
afterEach(() => {
    rmSync(TASKS_DIR, { recursive: true, force: true });
    rmSync(TEAMS_DIR, { recursive: true, force: true });
    rmSync(WORK_DIR, { recursive: true, force: true });
});
describe('Bridge Integration', () => {
    describe('Task lifecycle', () => {
        it('writes heartbeat files correctly', () => {
            const config = makeConfig();
            writeHeartbeat(config.workingDirectory, {
                workerName: config.workerName,
                teamName: config.teamName,
                provider: config.provider,
                pid: process.pid,
                lastPollAt: new Date().toISOString(),
                consecutiveErrors: 0,
                status: 'polling',
            });
            const hb = readHeartbeat(config.workingDirectory, config.teamName, config.workerName);
            expect(hb).not.toBeNull();
            expect(hb?.status).toBe('polling');
            expect(hb?.workerName).toBe('worker1');
        });
        it('task can transition pending -> in_progress -> completed', () => {
            writeTask({
                id: '1', subject: 'Test task', description: 'Do something',
                status: 'pending', owner: 'worker1', blocks: [], blockedBy: [],
            });
            updateTask(TEST_TEAM, '1', { status: 'in_progress' });
            let task = readTask(TEST_TEAM, '1');
            expect(task?.status).toBe('in_progress');
            updateTask(TEST_TEAM, '1', { status: 'completed' });
            task = readTask(TEST_TEAM, '1');
            expect(task?.status).toBe('completed');
        });
    });
    describe('Shutdown signaling', () => {
        it('shutdown signal write/read/delete cycle', () => {
            const config = makeConfig();
            // No signal initially
            expect(checkShutdownSignal(config.teamName, config.workerName)).toBeNull();
            // Write signal
            writeShutdownSignal(config.teamName, config.workerName, 'req-001', 'Task complete');
            const signal = checkShutdownSignal(config.teamName, config.workerName);
            expect(signal).not.toBeNull();
            expect(signal?.requestId).toBe('req-001');
            expect(signal?.reason).toBe('Task complete');
        });
    });
    describe('Quarantine behavior', () => {
        it('quarantine is reflected in heartbeat status', () => {
            const config = makeConfig();
            writeHeartbeat(config.workingDirectory, {
                workerName: config.workerName,
                teamName: config.teamName,
                provider: config.provider,
                pid: process.pid,
                lastPollAt: new Date().toISOString(),
                consecutiveErrors: config.maxConsecutiveErrors,
                status: 'quarantined',
            });
            const hb = readHeartbeat(config.workingDirectory, config.teamName, config.workerName);
            expect(hb?.status).toBe('quarantined');
            expect(hb?.consecutiveErrors).toBe(3);
        });
    });
    describe('Task with blockers', () => {
        it('blocked task not picked up until blocker completes', async () => {
            writeTask({
                id: '1', subject: 'Blocker', description: 'Must finish first',
                status: 'pending', owner: 'other', blocks: ['2'], blockedBy: [],
            });
            writeTask({
                id: '2', subject: 'Blocked', description: 'Depends on 1',
                status: 'pending', owner: 'worker1', blocks: [], blockedBy: ['1'],
            });
            // Task 2 should not be found — blocker is pending
            const { findNextTask } = await import('../task-file-ops.js');
            expect(await findNextTask(TEST_TEAM, 'worker1')).toBeNull();
            // Complete blocker
            updateTask(TEST_TEAM, '1', { status: 'completed' });
            const next = await findNextTask(TEST_TEAM, 'worker1');
            expect(next?.id).toBe('2');
        });
    });
});
describe('validateBridgeWorkingDirectory logic', () => {
    // validateBridgeWorkingDirectory is private in bridge-entry.ts, so we
    // replicate its core checks to validate the security properties.
    function validateBridgeWorkingDirectory(workingDirectory) {
        let stat;
        try {
            stat = statSync(workingDirectory);
        }
        catch {
            throw new Error(`workingDirectory does not exist: ${workingDirectory}`);
        }
        if (!stat.isDirectory()) {
            throw new Error(`workingDirectory is not a directory: ${workingDirectory}`);
        }
        const resolved = realpathSync(workingDirectory);
        const home = homedir();
        if (!resolved.startsWith(home + '/') && resolved !== home) {
            throw new Error(`workingDirectory is outside home directory: ${resolved}`);
        }
    }
    it('rejects /etc as working directory', () => {
        expect(() => validateBridgeWorkingDirectory('/etc')).toThrow('outside home directory');
    });
    it('rejects /tmp as working directory (outside home)', () => {
        // /tmp is typically outside $HOME
        const home = homedir();
        if (!'/tmp'.startsWith(home)) {
            expect(() => validateBridgeWorkingDirectory('/tmp')).toThrow('outside home directory');
        }
    });
    it('accepts a valid directory under home', () => {
        const testDir = join(homedir(), '.claude', '__bridge_validate_test__');
        mkdirSync(testDir, { recursive: true });
        try {
            expect(() => validateBridgeWorkingDirectory(testDir)).not.toThrow();
        }
        finally {
            rmSync(testDir, { recursive: true, force: true });
        }
    });
    it('rejects nonexistent directory', () => {
        expect(() => validateBridgeWorkingDirectory('/nonexistent/path/xyz'))
            .toThrow('does not exist');
    });
});
describe('Config name sanitization', () => {
    it('sanitizeName strips unsafe characters from team names', () => {
        expect(sanitizeName('my-team')).toBe('my-team');
        expect(sanitizeName('team@name!')).toBe('teamname');
    });
    it('sanitizeName strips unsafe characters from worker names', () => {
        expect(sanitizeName('worker-1')).toBe('worker-1');
        expect(sanitizeName('worker;rm -rf /')).toBe('workerrm-rf');
    });
    it('config names are sanitized before use', () => {
        // Simulates what bridge-entry.ts does with config
        const config = makeConfig({ teamName: 'unsafe!team@', workerName: 'bad$worker' });
        config.teamName = sanitizeName(config.teamName);
        config.workerName = sanitizeName(config.workerName);
        expect(config.teamName).toBe('unsafeteam');
        expect(config.workerName).toBe('badworker');
    });
});
//# sourceMappingURL=bridge-integration.test.js.map