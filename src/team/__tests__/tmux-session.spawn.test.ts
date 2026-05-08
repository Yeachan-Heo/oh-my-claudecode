import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockedCalls = vi.hoisted(() => ({
  tmuxArgs: [] as string[][],
}));

vi.mock('../../cli/tmux-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cli/tmux-utils.js')>();
  return {
    ...actual,
    tmuxExec: vi.fn((args: string[]) => {
      mockedCalls.tmuxArgs.push(args);
      return '';
    }),
    tmuxExecAsync: vi.fn(async (args: string[]) => {
      mockedCalls.tmuxArgs.push(args);
      return { stdout: '', stderr: '' };
    }),
  };
});

import { spawnBridgeInSession, spawnWorkerInPane } from '../tmux-session.js';

describe('spawnWorkerInPane', () => {
  beforeEach(() => {
    mockedCalls.tmuxArgs = [];
  });

  it('uses argv-style launch with literal tmux send-keys', async () => {
    await spawnWorkerInPane('session:0', '%2', {
      teamName: 'safe-team',
      workerName: 'worker-1',
      envVars: {
        OMC_TEAM_NAME: 'safe-team',
        OMC_TEAM_WORKER: 'safe-team/worker-1',
      },
      launchBinary: 'codex',
      launchArgs: ['--full-auto', '--model', 'gpt-5;touch /tmp/pwn'],
      cwd: '/tmp',
    });

    const literalSend = mockedCalls.tmuxArgs.find(
      (args) => args[0] === 'send-keys' && args.includes('-l')
    );
    expect(literalSend).toBeDefined();
    const launchLine = literalSend?.[literalSend.length - 1] ?? '';
    expect(launchLine).toContain('exec "$@"');
    expect(launchLine).toContain("'--'");
    expect(launchLine).toContain("'gpt-5;touch /tmp/pwn'");
    expect(launchLine).not.toContain('exec codex --full-auto');
  });

  it('uses current JS runtime when launching bridge-entry helpers', () => {
    spawnBridgeInSession('session:0', '/tmp/bridge-entry.js', '/tmp/bridge-config.json');

    const sendKeys = mockedCalls.tmuxArgs.find((args) => args[0] === 'send-keys');
    expect(sendKeys).toBeDefined();
    const launchLine = sendKeys?.[3] ?? '';
    expect(launchLine).toContain(process.execPath);
    expect(launchLine).toContain('/tmp/bridge-entry.js');
    expect(launchLine).toContain('--config');
    expect(launchLine).not.toMatch(/^node\s/);
  });

  it('rejects invalid team names before command construction', async () => {
    await expect(
      spawnWorkerInPane('session:0', '%2', {
        teamName: 'Bad-Team',
        workerName: 'worker-1',
        envVars: { OMC_TEAM_NAME: 'Bad-Team' },
        launchBinary: 'codex',
        launchArgs: ['--full-auto'],
        cwd: '/tmp',
      })
    ).rejects.toThrow('Invalid team name');
  });

  it('rejects invalid environment keys', async () => {
    await expect(
      spawnWorkerInPane('session:0', '%2', {
        teamName: 'safe-team',
        workerName: 'worker-1',
        envVars: { 'BAD-KEY': 'x' },
        launchBinary: 'codex',
        cwd: '/tmp',
      })
    ).rejects.toThrow('Invalid environment key');
  });

  it('rejects unsafe launchBinary values', async () => {
    await expect(
      spawnWorkerInPane('session:0', '%2', {
        teamName: 'safe-team',
        workerName: 'worker-1',
        envVars: { OMC_TEAM_NAME: 'safe-team' },
        launchBinary: 'codex;touch /tmp/pwn',
        cwd: '/tmp',
      })
    ).rejects.toThrow('Invalid launchBinary');
  });
});
