import { beforeEach, describe, expect, it, vi } from 'vitest';

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

const mockedCalls = vi.hoisted(() => ({
  execFileArgs: [] as string[][],
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: vi.fn((_cmd: string, args: string[], cb: ExecFileCallback) => {
      mockedCalls.execFileArgs.push(args);
      cb(null, '', '');
      return {} as never;
    }),
  };
});

import { spawnWorkerInPane } from '../tmux-session.js';

describe('spawnWorkerInPane', () => {
  beforeEach(() => {
    mockedCalls.execFileArgs = [];
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

    const literalSend = mockedCalls.execFileArgs.find(
      (args) => args[0] === 'send-keys' && args.includes('-l')
    );
    expect(literalSend).toBeDefined();
    const launchLine = literalSend?.[literalSend.length - 1] ?? '';
    expect(launchLine).toContain('exec "$@"');
    expect(launchLine).toContain("'--'");
    expect(launchLine).toContain("'gpt-5;touch /tmp/pwn'");
    expect(launchLine).not.toContain('exec codex --full-auto');
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
});
