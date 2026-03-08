import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const mocks = vi.hoisted(() => ({
  isWorkerAlive: vi.fn(),
}));

vi.mock('../tmux-session.js', async () => {
  const actual = await vi.importActual<typeof import('../tmux-session.js')>('../tmux-session.js');
  return {
    ...actual,
    isWorkerAlive: mocks.isWorkerAlive,
  };
});

import { watchdogCliWorkers, type TeamRuntime } from '../runtime.js';

describe('watchdog done.json parsing recovery', () => {
  beforeEach(() => {
    mocks.isWorkerAlive.mockReset();
  });

  it('marks task completed when done.json is briefly malformed before pane-dead check', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'team-runtime-done-recovery-'));
    const teamName = 'done-recovery-team';
    const root = join(cwd, '.omc', 'state', 'team', teamName);
    const tasksDir = join(root, 'tasks');
    const workerDir = join(root, 'workers', 'worker-1');
    const donePath = join(workerDir, 'done.json');

    mkdirSync(tasksDir, { recursive: true });
    mkdirSync(workerDir, { recursive: true });

    writeFileSync(join(tasksDir, '1.json'), JSON.stringify({
      id: '1',
      subject: 'Task 1',
      description: 'desc',
      status: 'in_progress',
      owner: 'worker-1',
      createdAt: new Date().toISOString(),
      assignedAt: new Date().toISOString(),
    }), 'utf-8');

    writeFileSync(donePath, '{"taskId":"1","status":"completed","summary":"ok"', 'utf-8');

    // Simulate worker pane already exited. Recovery must come from done.json re-parse.
    mocks.isWorkerAlive.mockResolvedValue(false);

    const runtime: TeamRuntime = {
      teamName,
      sessionName: 'omc-team-test',
      leaderPaneId: '%0',
      ownsWindow: false,
      config: {
        teamName,
        workerCount: 1,
        agentTypes: ['codex'],
        tasks: [{ subject: 'Task 1', description: 'desc' }],
        cwd,
      },
      workerNames: ['worker-1'],
      workerPaneIds: ['%1'],
      activeWorkers: new Map([
        ['worker-1', { paneId: '%1', taskId: '1', spawnedAt: Date.now() }],
      ]),
      cwd,
    };

    const stop = watchdogCliWorkers(runtime, 20);

    setTimeout(() => {
      writeFileSync(donePath, JSON.stringify({
        taskId: '1',
        status: 'completed',
        summary: 'done',
        completedAt: new Date().toISOString(),
      }), 'utf-8');
    }, 40);

    await new Promise(resolve => setTimeout(resolve, 220));
    stop();

    const task = JSON.parse(readFileSync(join(tasksDir, '1.json'), 'utf-8')) as {
      status: string;
      summary?: string;
    };

    expect(task.status).toBe('completed');
    expect(task.summary).toBe('done');
    expect(existsSync(donePath)).toBe(false);

    rmSync(cwd, { recursive: true, force: true });
  });
});
