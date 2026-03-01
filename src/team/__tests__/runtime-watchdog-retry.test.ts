import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { watchdogCliWorkers, type TeamRuntime } from '../runtime.js';
import { DEFAULT_MAX_TASK_RETRIES, readTaskFailure, writeTaskFailure } from '../task-file-ops.js';

const tmuxMocks = vi.hoisted(() => ({
  isWorkerAlive: vi.fn(),
  spawnWorkerInPane: vi.fn(),
  sendToWorker: vi.fn(),
}));

vi.mock('../tmux-session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tmux-session.js')>();
  return {
    ...actual,
    isWorkerAlive: tmuxMocks.isWorkerAlive,
    spawnWorkerInPane: tmuxMocks.spawnWorkerInPane,
    sendToWorker: tmuxMocks.sendToWorker,
  };
});

vi.mock('../model-contract.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../model-contract.js')>();
  return {
    ...actual,
    buildWorkerArgv: vi.fn(() => ['codex']),
    getWorkerEnv: vi.fn(() => ({})),
    isPromptModeAgent: vi.fn(() => true),
    getPromptModeArgs: vi.fn(() => ['-p', 'stub prompt']),
  };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const { promisify: utilPromisify } = await import('util');

  function mockExecFile(
    _cmd: string,
    args: string[],
    cb: (error: Error | null, stdout: string, stderr: string) => void
  ) {
    if (args[0] === 'split-window') {
      cb(null, '%42\n', '');
      return {} as never;
    }
    cb(null, '', '');
    return {} as never;
  }

  (mockExecFile as unknown as { [utilPromisify.custom]: unknown })[utilPromisify.custom] = async (
    _cmd: string,
    args: string[]
  ) => {
    if (args[0] === 'split-window') {
      return { stdout: '%42\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };

  return {
    ...actual,
    execFile: mockExecFile,
  };
});

function makeRuntime(cwd: string, teamName: string): TeamRuntime {
  return {
    teamName,
    sessionName: 'test-session:0',
    leaderPaneId: '%0',
    config: {
      teamName,
      workerCount: 1,
      agentTypes: ['codex'],
      tasks: [{ subject: 'Task 1', description: 'Do work' }],
      cwd,
    },
    workerNames: ['worker-1'],
    workerPaneIds: ['%1'],
    activeWorkers: new Map([
      ['worker-1', { paneId: '%1', taskId: '1', spawnedAt: Date.now() }],
    ]),
    cwd,
  };
}

function initTask(cwd: string, teamName: string): string {
  const root = join(cwd, '.omc', 'state', 'team', teamName);
  mkdirSync(join(root, 'tasks'), { recursive: true });
  mkdirSync(join(root, 'workers', 'worker-1'), { recursive: true });
  writeFileSync(join(root, 'tasks', '1.json'), JSON.stringify({
    id: '1',
    subject: 'Task 1',
    description: 'Do work',
    status: 'in_progress',
    owner: 'worker-1',
    assignedAt: new Date().toISOString(),
  }), 'utf-8');
  return root;
}

async function waitFor(predicate: () => boolean, timeoutMs = 750): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for watchdog condition');
}

describe('watchdogCliWorkers dead-pane retry behavior', () => {
  let cwd: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'runtime-watchdog-retry-'));
    tmuxMocks.isWorkerAlive.mockReset();
    tmuxMocks.spawnWorkerInPane.mockReset();
    tmuxMocks.sendToWorker.mockReset();
    tmuxMocks.isWorkerAlive.mockResolvedValue(false);
    tmuxMocks.spawnWorkerInPane.mockResolvedValue(undefined);
    tmuxMocks.sendToWorker.mockResolvedValue(true);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    rmSync(cwd, { recursive: true, force: true });
  });

  it('requeues task when dead pane still has retries remaining', async () => {
    const teamName = 'dead-pane-requeue-team';
    const root = initTask(cwd, teamName);
    const runtime = makeRuntime(cwd, teamName);
    const stop = watchdogCliWorkers(runtime, 20);

    await waitFor(() => tmuxMocks.spawnWorkerInPane.mock.calls.length > 0);
    stop();

    const task = JSON.parse(readFileSync(join(root, 'tasks', '1.json'), 'utf-8')) as {
      status: string;
      owner: string | null;
    };
    const failure = readTaskFailure(teamName, '1', { cwd });

    expect(task.status).toBe('in_progress');
    expect(task.owner).toBe('worker-1');
    expect(failure?.retryCount).toBe(1);
    expect(
      warnSpy.mock.calls.some(([msg]: [unknown]) => String(msg).includes('dead pane — requeuing task 1 (retry 1/5)'))
    ).toBe(true);
  });

  it('permanently fails task when dead pane exhausts retry budget', async () => {
    const teamName = 'dead-pane-exhausted-team';
    const root = initTask(cwd, teamName);
    for (let i = 0; i < DEFAULT_MAX_TASK_RETRIES - 1; i++) {
      writeTaskFailure(teamName, '1', `pre-error-${i}`, { cwd });
    }
    const runtime = makeRuntime(cwd, teamName);
    const stop = watchdogCliWorkers(runtime, 20);

    await waitFor(() => runtime.activeWorkers.size === 0);
    stop();

    const task = JSON.parse(readFileSync(join(root, 'tasks', '1.json'), 'utf-8')) as {
      status: string;
      summary?: string;
    };
    const failure = readTaskFailure(teamName, '1', { cwd });

    expect(task.status).toBe('failed');
    expect(task.summary).toContain('Worker pane died before done.json was written');
    expect(failure?.retryCount).toBe(DEFAULT_MAX_TASK_RETRIES);
    expect(tmuxMocks.spawnWorkerInPane).not.toHaveBeenCalled();
  });
});
