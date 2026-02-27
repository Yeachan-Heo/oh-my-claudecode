import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, statSync, realpathSync } from 'fs';
import type { Stats } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import type { BridgeConfig, TaskFile, OutboxMessage } from '../types.js';
import { readTask, updateTask } from '../task-file-ops.js';
import { checkShutdownSignal, writeShutdownSignal, appendOutbox } from '../inbox-outbox.js';
import { writeHeartbeat, readHeartbeat } from '../heartbeat.js';
import { sanitizeName } from '../tmux-session.js';
import { logAuditEvent, readAuditLog } from '../audit-log.js';

const TEST_TEAM = 'test-bridge-int';
// Task files now live in the canonical .omc/state/team path (relative to WORK_DIR)
const TEAMS_DIR = join(homedir(), '.claude', 'teams', TEST_TEAM);
const WORK_DIR = join(tmpdir(), '__test_bridge_work__');
// Canonical tasks dir for this team
const TASKS_DIR = join(WORK_DIR, '.omc', 'state', 'team', TEST_TEAM, 'tasks');

function writeTask(task: TaskFile): void {
  mkdirSync(TASKS_DIR, { recursive: true });
  writeFileSync(join(TASKS_DIR, `${task.id}.json`), JSON.stringify(task, null, 2));
}

function readOutbox(): OutboxMessage[] {
  const outboxFile = join(TEAMS_DIR, 'outbox', `worker1.jsonl`);
  if (!existsSync(outboxFile)) return [];
  return readFileSync(outboxFile, 'utf-8')
    .trim()
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l));
}

function makeConfig(overrides?: Partial<BridgeConfig>): BridgeConfig {
  return {
    teamName: TEST_TEAM,
    workerName: 'worker1',
    provider: 'codex',
    workingDirectory: WORK_DIR,
    pollIntervalMs: 100,        // Fast polling for tests
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

      updateTask(TEST_TEAM, '1', { status: 'in_progress' }, { cwd: WORK_DIR });
      let task = readTask(TEST_TEAM, '1', { cwd: WORK_DIR });
      expect(task?.status).toBe('in_progress');

      updateTask(TEST_TEAM, '1', { status: 'completed' }, { cwd: WORK_DIR });
      task = readTask(TEST_TEAM, '1', { cwd: WORK_DIR });
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
      expect(await findNextTask(TEST_TEAM, 'worker1', { cwd: WORK_DIR })).toBeNull();

      // Complete blocker
      updateTask(TEST_TEAM, '1', { status: 'completed' }, { cwd: WORK_DIR });
      const next = await findNextTask(TEST_TEAM, 'worker1', { cwd: WORK_DIR });
      expect(next?.id).toBe('2');
    });
  });

  describe('Ready status hook', () => {
    it('emits a ready outbox message after first successful poll cycle', () => {
      const config = makeConfig();

      // Simulate what runBridge() now does: heartbeat at startup,
      // then ready emitted after first successful poll (heartbeat write succeeds)
      writeHeartbeat(config.workingDirectory, {
        workerName: config.workerName,
        teamName: config.teamName,
        provider: config.provider,
        pid: process.pid,
        lastPollAt: new Date().toISOString(),
        consecutiveErrors: 0,
        status: 'polling',
      });

      // Ready is now emitted inside the loop after first successful heartbeat
      appendOutbox(config.teamName, config.workerName, {
        type: 'ready',
        message: `Worker ${config.workerName} is ready (${config.provider})`,
        timestamp: new Date().toISOString(),
      });

      const messages = readOutbox();
      expect(messages.length).toBeGreaterThanOrEqual(1);
      const readyMsg = messages.find(m => m.type === 'ready');
      expect(readyMsg).toBeDefined();
      expect(readyMsg!.type).toBe('ready');
      expect(readyMsg!.message).toContain('worker1');
      expect(readyMsg!.message).toContain('codex');
      expect(readyMsg!.timestamp).toBeTruthy();
    });

    it('ready message appears before any idle message', () => {
      const config = makeConfig();

      // Emit ready (after first successful poll cycle)
      appendOutbox(config.teamName, config.workerName, {
        type: 'ready',
        message: `Worker ${config.workerName} is ready (${config.provider})`,
        timestamp: new Date().toISOString(),
      });

      // Emit idle (poll finds no tasks)
      appendOutbox(config.teamName, config.workerName, {
        type: 'idle',
        message: 'All assigned tasks complete. Standing by.',
        timestamp: new Date().toISOString(),
      });

      const messages = readOutbox();
      const readyIdx = messages.findIndex(m => m.type === 'ready');
      const idleIdx = messages.findIndex(m => m.type === 'idle');
      expect(readyIdx).toBeLessThan(idleIdx);
    });

    it('ready message type is valid in OutboxMessage union', () => {
      const msg: OutboxMessage = {
        type: 'ready',
        message: 'test',
        timestamp: new Date().toISOString(),
      };
      expect(msg.type).toBe('ready');
    });

    it('emits worker_ready audit event when ready outbox message is written', () => {
      const config = makeConfig();

      // Simulate the bridge ready sequence: heartbeat -> outbox -> audit
      writeHeartbeat(config.workingDirectory, {
        workerName: config.workerName,
        teamName: config.teamName,
        provider: config.provider,
        pid: process.pid,
        lastPollAt: new Date().toISOString(),
        consecutiveErrors: 0,
        status: 'ready',
      });

      appendOutbox(config.teamName, config.workerName, {
        type: 'ready',
        message: `Worker ${config.workerName} is ready (${config.provider})`,
        timestamp: new Date().toISOString(),
      });

      logAuditEvent(config.workingDirectory, {
        timestamp: new Date().toISOString(),
        eventType: 'worker_ready',
        teamName: config.teamName,
        workerName: config.workerName,
      });

      // Verify audit event was logged
      const events = readAuditLog(config.workingDirectory, config.teamName, {
        eventType: 'worker_ready',
      });
      expect(events.length).toBe(1);
      expect(events[0].eventType).toBe('worker_ready');
      expect(events[0].workerName).toBe('worker1');
    });

    it('writes ready heartbeat status before transitioning to polling', () => {
      const config = makeConfig();

      // Write ready heartbeat (as the bridge now does on first successful poll)
      writeHeartbeat(config.workingDirectory, {
        workerName: config.workerName,
        teamName: config.teamName,
        provider: config.provider,
        pid: process.pid,
        lastPollAt: new Date().toISOString(),
        consecutiveErrors: 0,
        status: 'ready',
      });

      const hb = readHeartbeat(config.workingDirectory, config.teamName, config.workerName);
      expect(hb).not.toBeNull();
      expect(hb?.status).toBe('ready');

      // Then transitions to polling on next cycle
      writeHeartbeat(config.workingDirectory, {
        workerName: config.workerName,
        teamName: config.teamName,
        provider: config.provider,
        pid: process.pid,
        lastPollAt: new Date().toISOString(),
        consecutiveErrors: 0,
        status: 'polling',
      });

      const hb2 = readHeartbeat(config.workingDirectory, config.teamName, config.workerName);
      expect(hb2?.status).toBe('polling');
    });
  });
});

describe('validateBridgeWorkingDirectory logic', () => {
  // validateBridgeWorkingDirectory is private in bridge-entry.ts, so we
  // replicate its core checks to validate the security properties.

  function validateBridgeWorkingDirectory(workingDirectory: string): void {
    let stat: Stats;
    try {
      stat = statSync(workingDirectory);
    } catch {
      throw new Error(`workingDirectory does not exist: ${workingDirectory}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`workingDirectory is not a directory: ${workingDirectory}`);
    }
    const resolved = realpathSync(workingDirectory).replaceAll('\\', '/');
    const home = homedir().replaceAll('\\', '/');
    if (!resolved.startsWith(home + '/') && resolved !== home) {
      throw new Error(`workingDirectory is outside home directory: ${resolved}`);
    }
  }

  it('rejects /etc as working directory', () => {
    const outsideDir = process.platform === 'win32' ? 'C:\\Windows' : '/etc';
    expect(() => validateBridgeWorkingDirectory(outsideDir)).toThrow('outside home directory');
  });

  it('rejects /tmp as working directory (outside home)', () => {
    const outsideTmp = process.platform === 'win32' ? 'C:\\Windows\\Temp' : '/tmp';
    const home = homedir().replaceAll('\\', '/');
    const normalizedOutside = outsideTmp.replaceAll('\\', '/');
    if (!normalizedOutside.startsWith(home + '/') && normalizedOutside !== home) {
      expect(() => validateBridgeWorkingDirectory(outsideTmp)).toThrow('outside home directory');
    }
  });

  it('accepts a valid directory under home', () => {
    const testDir = join(homedir(), '.claude', '__bridge_validate_test__');
    mkdirSync(testDir, { recursive: true });
    try {
      expect(() => validateBridgeWorkingDirectory(testDir)).not.toThrow();
    } finally {
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
