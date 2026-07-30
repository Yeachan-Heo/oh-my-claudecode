import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const childProcess = vi.hoisted(() => ({ spawn: vi.fn() }));
const processUtils = vi.hoisted(() => ({
  getProcessStartIdentity: vi.fn(),
  getProcessStartIdentitySync: vi.fn(() => 'sync-identity'),
  terminateOwnedProcessTree: vi.fn(async (): Promise<'terminated' | 'unknown'> => 'terminated'),
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
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

beforeEach(() => {
  processUtils.getProcessStartIdentitySync.mockReturnValue('sync-identity');
  manifest.markSessionEndActionRunner.mockReturnValue({});
});

describe('SessionEnd action runner', () => {
  it('observes a fast child exit via microtask after synchronous identity capture', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-action-runner-'));
    directories.push(directory);
    const child = Object.assign(new EventEmitter(), { pid: 12345, unref: vi.fn() });
    childProcess.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('exit', 7));
      return child;
    });
    manifest.markSessionEndActionRunner.mockReturnValue({});

    await expect(runSessionEndAction(context(directory), async () => undefined)).resolves.toEqual({
      code: 'runner-exit-7',
      completed: false,
    });
  });

  it('waits for a delayed process-tree kill after a deadline even when the child exits immediately', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const directory = mkdtempSync(join(tmpdir(), 'omc-action-runner-'));
    directories.push(directory);
    const child = Object.assign(new EventEmitter(), { pid: 12347, unref: vi.fn() });
    childProcess.spawn.mockReturnValue(child);
    
    let finishKill!: () => void;
    processUtils.terminateOwnedProcessTree.mockImplementation(() => new Promise<'terminated'>((resolve) => { finishKill = () => resolve('terminated'); }));
    const result = runSessionEndAction({ ...context(directory), deadlineAt: now + 10 }, async () => undefined);

    await vi.advanceTimersByTimeAsync(10);
    expect(processUtils.terminateOwnedProcessTree).toHaveBeenCalledWith(expect.objectContaining({
      pid: 12347, expectedStartIdentity: 'sync-identity', force: true,
    }));
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
    const now = Date.now();
    const directory = mkdtempSync(join(tmpdir(), 'omc-action-runner-'));
    directories.push(directory);
    const child = Object.assign(new EventEmitter(), { pid: 12348, unref: vi.fn() });
    childProcess.spawn.mockReturnValue(child);
    
    processUtils.terminateOwnedProcessTree.mockResolvedValue('unknown');

    const result = runSessionEndAction({ ...context(directory), deadlineAt: now + 10 }, async () => undefined);
    await vi.advanceTimersByTimeAsync(10 + 250);

    await expect(result).resolves.toEqual({ code: 'runner-deadline', completed: false });
    expect(processUtils.terminateOwnedProcessTree).toHaveBeenCalledWith(expect.objectContaining({
      pid: 12348, expectedStartIdentity: 'sync-identity', force: true,
    }));
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
  it('fails closed without signalling any PID when synchronous identity capture returns null', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-action-runner-identity-null-'));
    directories.push(directory);
    const child = Object.assign(new EventEmitter(), { pid: 99999, unref: vi.fn(), kill: vi.fn() });
    childProcess.spawn.mockImplementation(() => child);
    processUtils.getProcessStartIdentitySync.mockReturnValueOnce(null as unknown as string);

    const result = await runSessionEndAction(context(directory), async () => undefined);

    expect(result.code).toBe('runner-identity-unavailable');
    expect(result.completed).toBe(false);
    // No signal must be sent to any PID or process group when identity is null
    expect(child.kill).not.toHaveBeenCalled();
    expect(processUtils.terminateOwnedProcessTree).not.toHaveBeenCalled();
  });

  it('uses synchronous identity for owned-tree termination on deadline', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const directory = mkdtempSync(join(tmpdir(), 'omc-action-runner-sync-id-'));
    directories.push(directory);
    const child = Object.assign(new EventEmitter(), { pid: 88888, unref: vi.fn() });
    childProcess.spawn.mockReturnValue(child);
    processUtils.getProcessStartIdentitySync.mockReturnValueOnce('sync-id-88888');
    processUtils.terminateOwnedProcessTree.mockImplementation(() => new Promise<'terminated'>(resolve => queueMicrotask(() => resolve('terminated'))));
    manifest.markSessionEndActionRunner.mockReturnValue({});

    const shortContext = { ...context(directory), deadlineAt: now + 10 };
    const resultP = runSessionEndAction(shortContext, async () => undefined);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(0);
    child.emit('exit', 0);
    const result = await resultP;

    expect(processUtils.terminateOwnedProcessTree).toHaveBeenCalledWith(
      expect.objectContaining({ pid: 88888, expectedStartIdentity: 'sync-id-88888', force: true }),
    );
    expect(result.completed).toBe(false);
  });
});
