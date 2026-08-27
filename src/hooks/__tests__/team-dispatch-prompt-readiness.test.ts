import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const tmuxUtilsMocks = vi.hoisted(() => ({
  tmuxExecAsync: vi.fn(async (_args: string[]) => ({ stdout: '', stderr: '' })),
}));

vi.mock('../../cli/tmux-utils.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../cli/tmux-utils.js')>(),
  tmuxExecAsync: tmuxUtilsMocks.tmuxExecAsync,
}));

import { drainPendingTeamDispatch } from '../team-dispatch-hook.js';
import type { TeamDispatchRequest } from '../../team/dispatch-queue.js';

const TEAM = 'dispatch-prompt-readiness-team';
const WORKER = 'worker-1';
const PANE = '%1';

let root: string;
let stateDir: string;
let logsDir: string;
let teamDir: string;
let savedEnv: NodeJS.ProcessEnv;

function makeRequest(): TeamDispatchRequest {
  const now = new Date().toISOString();
  return {
    request_id: 'request-1',
    kind: 'inbox',
    team_name: TEAM,
    to_worker: WORKER,
    worker_index: 1,
    pane_id: PANE,
    trigger_message: 'Review the inbox now',
    transport_preference: 'hook_preferred_with_fallback',
    fallback_allowed: true,
    status: 'pending',
    attempt_count: 0,
    created_at: now,
    updated_at: now,
  };
}

async function seed(workerCli?: string): Promise<void> {
  await writeFile(
    join(teamDir, 'config.json'),
    JSON.stringify({
      tmux_session: 'dispatch-session',
      workers: [{ name: WORKER, index: 1, pane_id: PANE, ...(workerCli === undefined ? {} : { worker_cli: workerCli }) }],
    }),
  );
  await writeFile(join(teamDir, 'dispatch', 'requests.json'), JSON.stringify([makeRequest()]));
}

async function seedMismatchedTarget(): Promise<void> {
  await writeFile(
    join(teamDir, 'config.json'),
    JSON.stringify({
      tmux_session: 'dispatch-session',
      workers: [
        { name: WORKER, index: 1, pane_id: '%2', worker_cli: 'cursor' },
        { name: 'worker-2', index: 2, pane_id: PANE, worker_cli: 'claude' },
      ],
    }),
  );
  await writeFile(join(teamDir, 'dispatch', 'requests.json'), JSON.stringify([makeRequest()]));
}

async function seedIncompleteCursorTarget(): Promise<void> {
  await seed('cursor');
  const request = makeRequest();
  delete request.pane_id;
  delete request.worker_index;
  await writeFile(join(teamDir, 'dispatch', 'requests.json'), JSON.stringify([request]));
}

async function runDefaultInjector(): Promise<{ result: Awaited<ReturnType<typeof drainPendingTeamDispatch>>; request: TeamDispatchRequest }> {
  const result = await drainPendingTeamDispatch({ cwd: root, stateDir, logsDir, maxPerTick: 1 });
  const requests = JSON.parse(await readFile(join(teamDir, 'dispatch', 'requests.json'), 'utf8')) as TeamDispatchRequest[];
  return { result, request: requests[0]! };
}

describe('team dispatch provider-aware prompt readiness', () => {
  beforeEach(async () => {
    tmuxUtilsMocks.tmuxExecAsync.mockReset().mockImplementation(async (args: string[]) => {
      if (args[0] === 'display-message') return { stdout: '0\n', stderr: '' };
      if (args[0] === 'capture-pane') return { stdout: '→ ', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    root = await mkdtemp(join(tmpdir(), 'omc-dispatch-prompt-readiness-'));
    stateDir = join(root, 'state');
    logsDir = join(root, 'logs');
    teamDir = join(stateDir, 'team', TEAM);
    await mkdir(join(teamDir, 'dispatch'), { recursive: true });

    savedEnv = { ...process.env };
    delete process.env.OMC_TEAM_WORKER;
    process.env.OMC_TEAM_DISPATCH_ISSUE_COOLDOWN_MS = '0';
    process.env.OMC_TEAM_DISPATCH_TRIGGER_COOLDOWN_MS = '0';
  });

  afterEach(async () => {
    process.env = savedEnv;
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('confirms and notifies a persisted Cursor worker from its arrow prompt', async () => {
    await seed('cursor');

    const { result, request } = await runDefaultInjector();

    expect(result).toMatchObject({ processed: 1, failed: 0 });
    expect(request).toMatchObject({ status: 'notified', last_reason: 'tmux_send_keys_confirmed' });
  });

  it('keeps an otherwise identical Claude worker unconfirmed on its first arrow-prompt retry', async () => {
    await seed('claude');

    const { result, request } = await runDefaultInjector();

    expect(result).toMatchObject({ processed: 0, skipped: 1, failed: 0 });
    expect(request).toMatchObject({
      status: 'pending',
      attempt_count: 1,
      last_reason: 'tmux_send_keys_unconfirmed',
    });
  });

  it.each([
    ['missing', undefined],
    ['unknown', 'not-a-supported-provider'],
  ])('does not treat an arrow prompt as generic when the provider is %s', async (_label, workerCli) => {
    await seed(workerCli);

    const { result, request } = await runDefaultInjector();

    expect(result).toMatchObject({ processed: 0, skipped: 1, failed: 0 });
    expect(request).toMatchObject({
      status: 'pending',
      attempt_count: 1,
      last_reason: 'tmux_send_keys_unconfirmed',
    });
  });

  it('fails closed when worker name, pane, and index identify different workers', async () => {
    await seedMismatchedTarget();

    const { result, request } = await runDefaultInjector();

    expect(result).toMatchObject({ processed: 1, skipped: 0, failed: 1 });
    expect(request).toMatchObject({
      status: 'failed',
      attempt_count: 1,
      last_reason: 'provider_identity_unverified',
    });
    expect(tmuxUtilsMocks.tmuxExecAsync).not.toHaveBeenCalled();
  });

  it('fails closed when a Cursor request lacks explicit pane and index identity', async () => {
    await seedIncompleteCursorTarget();

    const { result, request } = await runDefaultInjector();

    expect(result).toMatchObject({ processed: 1, skipped: 0, failed: 1 });
    expect(request).toMatchObject({
      status: 'failed',
      attempt_count: 1,
      last_reason: 'provider_identity_unverified',
    });
    expect(tmuxUtilsMocks.tmuxExecAsync).not.toHaveBeenCalled();
  });

  it('recognizes the Cursor active-task stop marker after injection', async () => {
    await seed('cursor');
    tmuxUtilsMocks.tmuxExecAsync.mockImplementation(async (args: string[]) => {
      if (args[0] === 'display-message') return { stdout: '0\n', stderr: '' };
      if (args[0] === 'capture-pane') {
        return { stdout: '→ Plan, search, build anything\nWorking on the task\nctrl+c to stop', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const { result, request } = await runDefaultInjector();

    expect(result).toMatchObject({ processed: 1, failed: 0 });
    expect(request).toMatchObject({
      status: 'notified',
      last_reason: 'tmux_send_keys_confirmed_active_task',
    });
  });

  it('fails closed without sending keys when Cursor exits on the workspace-trust banner', async () => {
    await seed('cursor');
    tmuxUtilsMocks.tmuxExecAsync.mockImplementation(async (args: string[]) => {
      if (args[0] === 'display-message') return { stdout: '0\n', stderr: '' };
      if (args[0] === 'capture-pane') {
        return {
          stdout: [
            '⚠ Workspace Trust Required',
            'Do you trust the contents of this directory?',
            'Pass --trust, --yolo, or -f if you trust this directory',
          ].join('\n'),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });

    const { result, request } = await runDefaultInjector();

    expect(result).toMatchObject({ processed: 1, skipped: 0, failed: 1 });
    expect(request).toMatchObject({
      status: 'failed',
      attempt_count: 1,
      last_reason: 'cursor_workspace_untrusted',
    });
    expect(tmuxUtilsMocks.tmuxExecAsync.mock.calls.some(([args]) => args[0] === 'send-keys')).toBe(false);
  });
});
