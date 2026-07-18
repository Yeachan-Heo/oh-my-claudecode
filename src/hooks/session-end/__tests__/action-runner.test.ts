import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const childProcess = vi.hoisted(() => ({ spawn: vi.fn() }));
const processUtils = vi.hoisted(() => ({
  getProcessStartIdentity: vi.fn(),
  killProcessTree: vi.fn(async () => true),
}));
const manifest = vi.hoisted(() => ({ markSessionEndActionRunner: vi.fn(() => ({})) }));

vi.mock('child_process', () => childProcess);
vi.mock('../../../platform/process-utils.js', () => processUtils);
vi.mock('../cleanup-manifest.js', async () => {
  const actual = await vi.importActual<typeof import('../cleanup-manifest.js')>('../cleanup-manifest.js');
  return { ...actual, markSessionEndActionRunner: manifest.markSessionEndActionRunner };
});

import { runSessionEndAction } from '../action-runner.js';

const directories: string[] = [];

function context(directory: string, actionName: 'foreground-cleanup' | 'notification' | 'openclaw' = 'foreground-cleanup') {
  return {
    directory,
    sessionId: 'fast-exit',
    job: { jobId: 'job-id' },
    actionName,
    action: { attempts: 1, idempotencyKey: 'action-key' },
    ownerNonce: 'owner',
    runnerNonce: 'runner',
    deadlineAt: Date.now() + 5_000,
  } as Parameters<typeof runSessionEndAction>[0];
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('SessionEnd action runner', () => {
  it('observes a fast child exit before publishing an arm or duplicate action', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-action-runner-'));
    directories.push(directory);
    const child = Object.assign(new EventEmitter(), { pid: 12345, unref: vi.fn() });
    childProcess.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('exit', 7));
      return child;
    });
    processUtils.getProcessStartIdentity.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve('identity'), 0)));

    await expect(runSessionEndAction(context(directory), async () => undefined)).resolves.toEqual({
      code: 'runner-exit-7',
      completed: false,
    });

    expect(manifest.markSessionEndActionRunner).not.toHaveBeenCalled();
    expect(existsSync(join(directory, '.omc', 'state', 'session-end-jobs', 'runs', 'job-id', 'foreground-cleanup', '1', 'runner', 'arm.json'))).toBe(false);
  });

  it('waits for a delayed process-tree kill after a deadline even when the child exits immediately', async () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), 'omc-action-runner-'));
    directories.push(directory);
    const child = Object.assign(new EventEmitter(), { pid: 12347, unref: vi.fn() });
    childProcess.spawn.mockReturnValue(child);
    processUtils.getProcessStartIdentity.mockResolvedValue('identity');
    let finishKill!: () => void;
    processUtils.killProcessTree.mockImplementation(() => new Promise<boolean>((resolve) => { finishKill = () => resolve(true); }));
    const result = runSessionEndAction({ ...context(directory), deadlineAt: Date.now() + 10 }, async () => undefined);

    await vi.advanceTimersByTimeAsync(10);
    expect(processUtils.killProcessTree).toHaveBeenCalledWith(12347, 'SIGKILL');
    child.emit('exit', 0);
    let settled = false;
    void result.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    finishKill();
    await expect(result).resolves.toEqual({ code: 'runner-deadline', completed: false });
  });

  it('returns after the post-kill deadline when Windows-style tree termination fails and the child never exits', async () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), 'omc-action-runner-'));
    directories.push(directory);
    const child = Object.assign(new EventEmitter(), { pid: 12348, unref: vi.fn() });
    childProcess.spawn.mockReturnValue(child);
    processUtils.getProcessStartIdentity.mockResolvedValue('identity');
    processUtils.killProcessTree.mockResolvedValue(false);

    const result = runSessionEndAction({ ...context(directory), deadlineAt: Date.now() + 10 }, async () => undefined);
    await vi.advanceTimersByTimeAsync(10 + 250);

    await expect(result).resolves.toEqual({ code: 'runner-deadline', completed: false });
    expect(processUtils.killProcessTree).toHaveBeenCalledWith(12348, 'SIGKILL');
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it('passes notification credentials only to notification action children', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-action-runner-'));
    directories.push(directory);
    const child = Object.assign(new EventEmitter(), { pid: 12346, unref: vi.fn() });
    childProcess.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('exit', 0));
      return child;
    });
    processUtils.getProcessStartIdentity.mockResolvedValue('identity');
    vi.stubEnv('OMC_DISCORD_WEBHOOK_URL', 'https://discord.com/api/webhooks/secret');
    vi.stubEnv('OMC_DISCORD', '1');

    await runSessionEndAction(context(directory, 'notification'), async () => undefined);
    const notificationEnvironment = childProcess.spawn.mock.calls[0][2].env as NodeJS.ProcessEnv;
    expect(notificationEnvironment).toMatchObject({
      OMC_DISCORD: '1',
      OMC_DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/secret',
    });

    await runSessionEndAction(context(directory, 'foreground-cleanup'), async () => undefined);
    const cleanupEnvironment = childProcess.spawn.mock.calls[1][2].env as NodeJS.ProcessEnv;
    expect(cleanupEnvironment).not.toHaveProperty('OMC_DISCORD');
    expect(cleanupEnvironment).not.toHaveProperty('OMC_DISCORD_WEBHOOK_URL');
  });

  it('uses original bounded OpenClaw routing instead of a recovering session ambient environment', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-action-runner-'));
    directories.push(directory);
    const child = Object.assign(new EventEmitter(), { pid: 12349, unref: vi.fn() });
    childProcess.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('exit', 0));
      return child;
    });
    processUtils.getProcessStartIdentity.mockResolvedValue('identity');
    vi.stubEnv('OMC_OPENCLAW', '1');
    vi.stubEnv('OMC_OPENCLAW_CONFIG', '/tmp/recovering-session.json');
    vi.stubEnv('OPENCLAW_REPLY_CHANNEL', '#new-session');
    vi.stubEnv('OPENCLAW_REPLY_TARGET', '@new-session');
    vi.stubEnv('OPENCLAW_REPLY_THREAD', 'new-thread');
    vi.stubEnv('OPENCLAW_REPLY_TOKEN', 'new-session-secret');
    vi.stubEnv('TMUX', '/tmp/tmux-new');
    vi.stubEnv('TMUX_PANE', '%99');
    vi.stubEnv('OMC_DISCORD_WEBHOOK_URL', 'not-for-openclaw');

    const runContext = context(directory, 'openclaw');
    runContext.action.payload = {
      openClawEnabled: true,
      openClawRouting: {
        openClawConfig: '/tmp/original-session.json',
        replyChannel: '#original-session',
        replyTarget: '@original-session',
        replyThread: 'original-thread',
        tmux: '/tmp/tmux-original',
        tmuxPane: '%7',
      },
    };
    await runSessionEndAction(runContext, async () => undefined);
    const environment = childProcess.spawn.mock.calls[0][2].env as NodeJS.ProcessEnv;
    expect(environment).toMatchObject({
      OMC_OPENCLAW: '1',
      OMC_OPENCLAW_CONFIG: '/tmp/original-session.json',
      OPENCLAW_REPLY_CHANNEL: '#original-session',
      OPENCLAW_REPLY_TARGET: '@original-session',
      OPENCLAW_REPLY_THREAD: 'original-thread',
      TMUX: '/tmp/tmux-original',
      TMUX_PANE: '%7',
    });
    expect(environment).not.toHaveProperty('OPENCLAW_REPLY_TOKEN');
    expect(environment).not.toHaveProperty('OMC_DISCORD_WEBHOOK_URL');
  });
});
