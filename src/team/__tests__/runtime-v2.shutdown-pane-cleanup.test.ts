import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { isProcessAlive } from '../../platform/process-utils.js';
import { resolveRuntimeCliPath } from '../runtime-owner-client.js';
import { awaitWorkerLaunchAcknowledgement, awaitWorkerLaunchProviderStarted, buildWorkerLaunchBootstrapSpec,
  prepareWorkerLaunchAttempt, runWorkerLaunchBootstrap } from '../worker-launch-ack.js';

type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void;
type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

const execFileMock = vi.hoisted(() => vi.fn());
const execMock = vi.hoisted(() => vi.fn());
const tmuxCalls = vi.hoisted(() => [] as string[][]);

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    exec: execMock,
    execFile: execFileMock,
  };
});

async function writeJson(cwd: string, relativePath: string, value: unknown): Promise<void> {
  const fullPath = join(cwd, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, JSON.stringify(value, null, 2), 'utf-8');
}

describe('shutdownTeamV2 split-pane pane cleanup', () => {
  let cwd = '';

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-v2-pane-cleanup-'));
    tmuxCalls.length = 0;
    execFileMock.mockReset();
    execMock.mockReset();

    const run = (args: string[]) => {
      tmuxCalls.push(args);
      let stdout = '';
      if (args[0] === 'list-panes') {
        stdout = '%1\n%2\n%3\n';
      } else if (args[0] === 'display-message' && args.includes('#{pane_dead}')) {
        stdout = '1\n';
      }
      return { stdout, stderr: '' };
    };

    const parseTmuxShellCmd = (cmd: string): string[] | null => {
      const match = cmd.match(/^tmux\s+(.+)$/);
      if (!match) return null;
      const args = match[1].match(/'([^']*(?:\\.[^']*)*)'|"([^"]*)"/g);
      if (!args) return null;
      return args.map((token) => {
        if (token.startsWith("'")) return token.slice(1, -1).replace(/'\\''/g, "'");
        return token.slice(1, -1);
      });
    };

    execFileMock.mockImplementation((_cmd: string, args: string[], cb?: ExecFileCallback) => {
      const { stdout, stderr } = run(args);
      if (cb) cb(null, stdout, stderr);
      return {} as never;
    });
    (execFileMock as unknown as Record<symbol, unknown>)[Symbol.for('nodejs.util.promisify.custom')] =
      async (_cmd: string, args: string[]) => run(args);

    execMock.mockImplementation((cmd: string, cb: ExecCallback) => {
      const { stdout, stderr } = run(parseTmuxShellCmd(cmd) ?? []);
      cb(null, stdout, stderr);
      return {} as never;
    });
    (execMock as unknown as Record<symbol, unknown>)[Symbol.for('nodejs.util.promisify.custom')] =
      async (cmd: string) => run(parseTmuxShellCmd(cmd) ?? []);
  });

  afterEach(async () => {
    tmuxCalls.length = 0;
    execFileMock.mockReset();
    execMock.mockReset();
    if (cwd) {
      await rm(cwd, { recursive: true, force: true });
      cwd = '';
    }
  });

  it('kills the owned pane but preserves state when provider launch identity is missing', async () => {
    const teamName = 'pane-cleanup-team';
    const teamRoot = `.omc/state/team/${teamName}`;

    await writeJson(cwd, `${teamRoot}/config.json`, {
      name: teamName,
      task: 'demo',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 2,
      max_workers: 20,
      workers: [
        { name: 'worker-1', index: 1, role: 'claude', assigned_tasks: [], pane_id: '%2' },
        { name: 'worker-2', index: 2, role: 'claude', assigned_tasks: [] },
      ],
      created_at: new Date().toISOString(),
      tmux_session: 'leader-session:0',
      tmux_window_owned: false,
      next_task_id: 1,
      leader_pane_id: '%1',
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
    });

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await shutdownTeamV2(teamName, cwd, { timeoutMs: 0 });

    const killPaneTargets = tmuxCalls
      .filter((args) => args[0] === 'kill-pane')
      .map((args) => args[2]);

    expect(killPaneTargets).toEqual(['%2']);
    expect(killPaneTargets).not.toContain('%1');
    await expect(readFile(join(cwd, teamRoot, 'config.json'), 'utf-8')).resolves.toContain('pane-cleanup-team');
  });
  it('retires and terminates the exact provider before removing pane state', async () => {
    const teamName = 'provider-cleanup-team';
    const teamRoot = `.omc/state/team/${teamName}`;
    const attempt = await prepareWorkerLaunchAttempt({ cwd, teamName, workerName: 'worker-1', paneId: '%2',
      provider: 'claude', runtimeCliPath: resolveRuntimeCliPath(), context: { kind: 'initial' } });
    const bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(
      attempt, [process.execPath, '-e', 'setInterval(()=>{},1000)'], cwd,
    ));
    await expect(awaitWorkerLaunchAcknowledgement(attempt, { timeoutMs: 2_000, pollIntervalMs: 5 }))
      .resolves.toEqual({ ok: true });
    await expect(awaitWorkerLaunchProviderStarted(attempt, { timeoutMs: 10_000, pollIntervalMs: 5 }))
      .resolves.toBe(true);
    const providerPid = JSON.parse(await readFile(attempt.startedPath, 'utf8')).pid as number;
    await writeJson(cwd, `${teamRoot}/config.json`, {
      name: teamName, task: 'demo', agent_type: 'claude', worker_launch_mode: 'interactive', worker_count: 1, max_workers: 20,
      workers: [{ name: 'worker-1', index: 1, role: 'claude', assigned_tasks: [], pane_id: '%2',
        worker_cli: 'claude', launch_attempt_id: attempt.attempt_id,
        launch_descriptor: { schema_version: 1, provider: 'claude', model: null, binary: process.execPath, args: [] } }],
      created_at: new Date().toISOString(), tmux_session: 'leader-session:0', tmux_window_owned: false,
      next_task_id: 1, leader_pane_id: '%1', hud_pane_id: null, resize_hook_name: null, resize_hook_target: null,
    });

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await shutdownTeamV2(teamName, cwd, { timeoutMs: 0, force: true });
    await expect(bootstrap).resolves.toMatchObject({ outcome: 'ran' });
    expect(isProcessAlive(providerPid)).toBe(false);
    expect(tmuxCalls.findIndex(args => args[0] === 'kill-pane' && args[2] === '%2')).toBeGreaterThanOrEqual(0);
    await expect(readFile(join(cwd, teamRoot, 'config.json'), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

});
