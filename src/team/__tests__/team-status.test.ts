import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { tmpdir } from 'os';
import { getTeamStatus } from '../team-status.js';
import { atomicWriteJson } from '../fs-utils.js';
import { appendOutbox } from '../inbox-outbox.js';
import type { HeartbeatData, TaskFile, OutboxMessage, McpWorkerMember } from '../types.js';

const TEST_TEAM = 'test-team-status';
const TEAMS_DIR = join(homedir(), '.claude', 'teams', TEST_TEAM);
const TASKS_DIR = join(homedir(), '.claude', 'tasks', TEST_TEAM);
let WORK_DIR: string;

beforeEach(() => {
  WORK_DIR = join(tmpdir(), `omc-team-status-test-${Date.now()}`);
  mkdirSync(join(TEAMS_DIR, 'outbox'), { recursive: true });
  mkdirSync(TASKS_DIR, { recursive: true });
  mkdirSync(join(WORK_DIR, '.omc', 'state', 'team-bridge', TEST_TEAM), { recursive: true });
  mkdirSync(join(WORK_DIR, '.omc', 'state'), { recursive: true });
});

afterEach(() => {
  rmSync(TEAMS_DIR, { recursive: true, force: true });
  rmSync(TASKS_DIR, { recursive: true, force: true });
  rmSync(WORK_DIR, { recursive: true, force: true });
});

function writeWorkerRegistry(workers: McpWorkerMember[]): void {
  const registryPath = join(WORK_DIR, '.omc', 'state', 'team-mcp-workers.json');
  atomicWriteJson(registryPath, { teamName: TEST_TEAM, workers });
}

function writeTask(task: TaskFile): void {
  atomicWriteJson(join(TASKS_DIR, `${task.id}.json`), task);
}

function writeHeartbeatFile(data: HeartbeatData): void {
  const hbPath = join(WORK_DIR, '.omc', 'state', 'team-bridge', TEST_TEAM, `${data.workerName}.heartbeat.json`);
  atomicWriteJson(hbPath, data);
}

function makeWorker(name: string, provider: 'codex' | 'gemini' = 'codex'): McpWorkerMember {
  return {
    agentId: `${name}@${TEST_TEAM}`,
    name,
    agentType: `mcp-${provider}`,
    model: 'test-model',
    joinedAt: Date.now(),
    tmuxPaneId: `omc-team-${TEST_TEAM}-${name}`,
    cwd: WORK_DIR,
    backendType: 'tmux',
    subscriptions: [],
  };
}

function makeHeartbeat(workerName: string, provider: 'codex' | 'gemini' = 'codex', ageMs: number = 0): HeartbeatData {
  return {
    workerName,
    teamName: TEST_TEAM,
    provider,
    pid: process.pid,
    lastPollAt: new Date(Date.now() - ageMs).toISOString(),
    consecutiveErrors: 0,
    status: 'polling',
  };
}

function makeTask(id: string, owner: string, status: 'pending' | 'in_progress' | 'completed' = 'pending'): TaskFile {
  return {
    id,
    subject: `Task ${id}`,
    description: `Description for task ${id}`,
    status,
    owner,
    blocks: [],
    blockedBy: [],
  };
}

describe('getTeamStatus', () => {
  it('returns empty status when no workers registered', () => {
    const status = getTeamStatus(TEST_TEAM, WORK_DIR);
    expect(status.teamName).toBe(TEST_TEAM);
    expect(status.workers).toEqual([]);
    expect(status.taskSummary.total).toBe(0);
    expect(status.lastUpdated).toBeTruthy();
  });

  it('aggregates worker status with heartbeats and tasks', () => {
    const w1 = makeWorker('w1', 'codex');
    const w2 = makeWorker('w2', 'gemini');
    writeWorkerRegistry([w1, w2]);

    // Write heartbeats (fresh)
    writeHeartbeatFile(makeHeartbeat('w1', 'codex', 1000));
    writeHeartbeatFile(makeHeartbeat('w2', 'gemini', 1000));

    // Write tasks
    writeTask(makeTask('1', 'w1', 'completed'));
    writeTask(makeTask('2', 'w1', 'in_progress'));
    writeTask(makeTask('3', 'w2', 'pending'));

    const status = getTeamStatus(TEST_TEAM, WORK_DIR);

    expect(status.workers).toHaveLength(2);

    const sw1 = status.workers.find(w => w.workerName === 'w1')!;
    expect(sw1.provider).toBe('codex');
    expect(sw1.isAlive).toBe(true);
    expect(sw1.heartbeat).not.toBeNull();
    expect(sw1.taskStats.completed).toBe(1);
    expect(sw1.taskStats.inProgress).toBe(1);
    expect(sw1.currentTask?.id).toBe('2');

    const sw2 = status.workers.find(w => w.workerName === 'w2')!;
    expect(sw2.provider).toBe('gemini');
    expect(sw2.taskStats.pending).toBe(1);

    expect(status.taskSummary.total).toBe(3);
    expect(status.taskSummary.completed).toBe(1);
    expect(status.taskSummary.inProgress).toBe(1);
    expect(status.taskSummary.pending).toBe(1);
  });

  it('detects dead workers via heartbeat age', () => {
    const w1 = makeWorker('w1');
    writeWorkerRegistry([w1]);

    // Write a stale heartbeat (older than default 30s)
    writeHeartbeatFile(makeHeartbeat('w1', 'codex', 60000));

    const status = getTeamStatus(TEST_TEAM, WORK_DIR);
    const sw1 = status.workers.find(w => w.workerName === 'w1')!;
    expect(sw1.isAlive).toBe(false);
    expect(sw1.heartbeat).not.toBeNull();
  });

  it('includes outbox messages', () => {
    const w1 = makeWorker('w1');
    writeWorkerRegistry([w1]);

    const msg: OutboxMessage = { type: 'task_complete', taskId: 't1', summary: 'done', timestamp: new Date().toISOString() };
    appendOutbox(TEST_TEAM, 'w1', msg);

    const status = getTeamStatus(TEST_TEAM, WORK_DIR);
    const sw1 = status.workers.find(w => w.workerName === 'w1')!;
    expect(sw1.recentMessages).toHaveLength(1);
    expect(sw1.recentMessages[0].type).toBe('task_complete');
  });

  it('respects custom heartbeatMaxAgeMs', () => {
    const w1 = makeWorker('w1');
    writeWorkerRegistry([w1]);

    // Heartbeat is 10s old
    writeHeartbeatFile(makeHeartbeat('w1', 'codex', 10000));

    // With 5s max age, worker should be dead
    const status5s = getTeamStatus(TEST_TEAM, WORK_DIR, 5000);
    expect(status5s.workers[0].isAlive).toBe(false);

    // With 15s max age, worker should be alive
    const status15s = getTeamStatus(TEST_TEAM, WORK_DIR, 15000);
    expect(status15s.workers[0].isAlive).toBe(true);
  });
});
