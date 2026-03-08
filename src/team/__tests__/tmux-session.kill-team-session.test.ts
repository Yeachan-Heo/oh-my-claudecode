import { afterEach, describe, expect, it, vi } from 'vitest';

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

const mocked = vi.hoisted(() => ({
  execFileCalls: [] as string[][],
  currentSession: 'leader-session',
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();

  const run = (args: string[]): { stdout: string; stderr: string } => {
    mocked.execFileCalls.push(args);
    if (args[0] === 'display-message' && args[1] === '-p' && args[2] === '#S') {
      return { stdout: `${mocked.currentSession}\n`, stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };

  const execFileMock = vi.fn((_cmd: string, args: string[], cb: ExecFileCallback) => {
    const out = run(args);
    cb(null, out.stdout, out.stderr);
    return {} as never;
  });

  const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');
  (execFileMock as unknown as Record<symbol, unknown>)[promisifyCustom] =
    async (_cmd: string, args: string[]) => run(args);

  return {
    ...actual,
    execFile: execFileMock,
  };
});

import { killTeamSession } from '../tmux-session.js';

describe('killTeamSession safeguards', () => {
  afterEach(() => {
    mocked.execFileCalls = [];
    mocked.currentSession = 'leader-session';
    vi.unstubAllEnvs();
  });

  it('does not kill the current attached session by default', async () => {
    vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
    mocked.currentSession = 'leader-session';

    await killTeamSession('leader-session');

    expect(mocked.execFileCalls.some((args) => args[0] === 'kill-session')).toBe(false);
  });

  it('kills a different detached session', async () => {
    vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
    mocked.currentSession = 'leader-session';

    await killTeamSession('worker-detached-session');

    expect(mocked.execFileCalls.some((args) =>
      args[0] === 'kill-session' && args.includes('worker-detached-session'),
    )).toBe(true);
  });

  it('kills only worker panes in split-pane mode', async () => {
    await killTeamSession('leader-session:0', ['%10', '%11'], '%10');

    const killPaneTargets = mocked.execFileCalls
      .filter((args) => args[0] === 'kill-pane')
      .map((args) => args[2]);

    expect(killPaneTargets).toEqual(['%11']);
    expect(mocked.execFileCalls.some((args) => args[0] === 'kill-session')).toBe(false);
    expect(mocked.execFileCalls.some((args) => args[0] === 'kill-window')).toBe(false);
  });

  it('kills an owned team window when session owns that window', async () => {
    await killTeamSession('leader-session:3', ['%10', '%11'], '%10', { sessionMode: 'dedicated-window' });

    expect(mocked.execFileCalls.some((args) =>
      args[0] === 'kill-window' && args.includes('leader-session:3'),
    )).toBe(true);
    expect(mocked.execFileCalls.some((args) => args[0] === 'kill-pane')).toBe(false);
  });
});
