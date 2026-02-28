import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const tmuxCalls = vi.hoisted(() => ({
  args: [] as string[][],
}));

const interopMocks = vi.hoisted(() => ({
  getInteropMode: vi.fn(() => 'active' as const),
  bridgeBootstrapToOmx: vi.fn(),
  pollOmxCompletion: vi.fn(async () => null),
}));

vi.mock('../../interop/mcp-bridge.js', () => ({
  getInteropMode: interopMocks.getInteropMode,
}));

vi.mock('../../interop/worker-adapter.js', () => ({
  bridgeBootstrapToOmx: interopMocks.bridgeBootstrapToOmx,
  pollOmxCompletion: interopMocks.pollOmxCompletion,
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const { promisify: utilPromisify } = await import('util');

  function mockExecFile(
    _cmd: string,
    args: string[],
    cb: (err: Error | null, stdout: string, stderr: string) => void
  ) {
    tmuxCalls.args.push(args);
    if (args[0] === 'split-window') {
      cb(null, '%77\n', '');
      return {} as never;
    }
    cb(null, '', '');
    return {} as never;
  }

  (mockExecFile as any)[utilPromisify.custom] = async (_cmd: string, args: string[]) => {
    tmuxCalls.args.push(args);
    if (args[0] === 'split-window') {
      return { stdout: '%77\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };

  return {
    ...actual,
    execFile: mockExecFile,
  };
});

import { spawnWorkerForTask, type TeamRuntime } from '../runtime.js';

function makeRuntime(cwd: string): TeamRuntime {
  return {
    teamName: 'test-team',
    sessionName: 'test-session:0',
    leaderPaneId: '%0',
    config: {
      teamName: 'test-team',
      workerCount: 1,
      agentTypes: ['codex'],
      tasks: [{ subject: 'Interop task', description: 'Do work' }],
      cwd,
      workerInteropConfigs: [
        { workerName: 'worker-1', agentType: 'codex', interopMode: 'omx' },
      ],
    },
    workerNames: ['worker-1'],
    workerPaneIds: [],
    activeWorkers: new Map(),
    cwd,
  };
}

function setupTaskDir(cwd: string): void {
  const tasksDir = join(cwd, '.omc/state/team/test-team/tasks');
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(tasksDir, '1.json'), JSON.stringify({
    id: '1',
    subject: 'Interop task',
    description: 'Do work',
    status: 'pending',
    owner: null,
  }));
  mkdirSync(join(cwd, '.omc/state/team/test-team/workers/worker-1'), { recursive: true });
}

describe('spawnWorkerForTask interop bootstrap fail-open', () => {
  let cwd: string;

  beforeEach(() => {
    tmuxCalls.args = [];
    cwd = mkdtempSync(join(tmpdir(), 'runtime-interop-spawn-'));
    setupTaskDir(cwd);
    interopMocks.getInteropMode.mockReset();
    interopMocks.getInteropMode.mockReturnValue('active');
    interopMocks.bridgeBootstrapToOmx.mockReset();
    interopMocks.bridgeBootstrapToOmx.mockRejectedValue(new Error('bootstrap failed'));
    interopMocks.pollOmxCompletion.mockReset();
    interopMocks.pollOmxCompletion.mockResolvedValue(null);
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('does not reject or reset task when bridge bootstrap throws', async () => {
    const runtime = makeRuntime(cwd);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const paneId = await spawnWorkerForTask(runtime, 'worker-1', 0);
    expect(paneId).toBe('%77');

    const taskPath = join(cwd, '.omc/state/team/test-team/tasks/1.json');
    const task = JSON.parse(readFileSync(taskPath, 'utf-8')) as { status: string; owner: string | null; };

    expect(task.status).toBe('in_progress');
    expect(task.owner).toBe('worker-1');
    expect(runtime.activeWorkers.get('worker-1')?.taskId).toBe('1');
    expect(interopMocks.bridgeBootstrapToOmx).toHaveBeenCalledTimes(1);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnMessage = String(warnSpy.mock.calls[0]?.[0] ?? '');
    expect(warnMessage).toContain('worker-1');
    expect(warnMessage).toContain('task 1');

    warnSpy.mockRestore();
  });
});
