import { afterEach, describe, expect, it, vi } from 'vitest';

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;
type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

const mocked = vi.hoisted(() => ({
  execCalls: [] as string[][],
  currentSession: 'leader-session',
  listedPanes: '%10\n%11\n',
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();

  const run = (args: string[]): { stdout: string; stderr: string } => {
    mocked.execCalls.push(args);
    if (args[0] === 'display-message' && args[1] === '-p' && args[2] === '#S') {
      return { stdout: `${mocked.currentSession}\n`, stderr: '' };
    }
    if (args[0] === 'list-panes') {
      return { stdout: mocked.listedPanes, stderr: '' };
    }
    return { stdout: '', stderr: '' };
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

  const execFileMock = vi.fn((_cmd: string, args: string[], cb: ExecFileCallback) => {
    const out = run(args);
    cb(null, out.stdout, out.stderr);
    return {} as never;
  });
  (execFileMock as unknown as Record<symbol, unknown>)[Symbol.for('nodejs.util.promisify.custom')] =
    async (_cmd: string, args: string[]) => run(args);

  const execMock = vi.fn((cmd: string, cb: ExecCallback) => {
    const args = parseTmuxShellCmd(cmd) ?? [];
    const out = run(args);
    cb(null, out.stdout, out.stderr);
    return {} as never;
  });
  (execMock as unknown as Record<symbol, unknown>)[Symbol.for('nodejs.util.promisify.custom')] =
    async (cmd: string) => run(parseTmuxShellCmd(cmd) ?? []);

  return {
    ...actual,
    exec: execMock,
    execFile: execFileMock,
  };
});

import { killTeamSession, resolveSplitPaneWorkerPaneIds } from '../tmux-session.js';

describe('killTeamSession safeguards', () => {
  afterEach(() => {
    mocked.execCalls = [];
    mocked.currentSession = 'leader-session';
    mocked.listedPanes = '%10\n%11\n';
    vi.unstubAllEnvs();
  });

  it('does not kill the current attached session by default', async () => {
    vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
    mocked.currentSession = 'leader-session';

    await expect(killTeamSession('leader-session')).resolves.toBe(false);

    expect(mocked.execCalls.some((args) => args[0] === 'kill-session')).toBe(false);
  });

  it('kills a different detached session', async () => {
    vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
    mocked.currentSession = 'leader-session';

    await expect(killTeamSession('worker-detached-session')).resolves.toBe(true);

    expect(mocked.execCalls.some((args) =>
      args[0] === 'kill-session' && args.includes('worker-detached-session'),
    )).toBe(true);
  });

  it('kills only worker panes in split-pane mode', async () => {
    await expect(killTeamSession('leader-session:0', ['%10', '%11'], '%10')).resolves.toBe(true);

    const killPaneTargets = mocked.execCalls
      .filter((args) => args[0] === 'kill-pane')
      .map((args) => args[2]);

    expect(killPaneTargets).toEqual(['%11']);
    expect(mocked.execCalls.some((args) => args[0] === 'kill-session')).toBe(false);
    expect(mocked.execCalls.some((args) => args[0] === 'kill-window')).toBe(false);
  });

  it('kills an owned team window when session owns that window', async () => {
    await expect(killTeamSession('leader-session:3', ['%10', '%11'], '%10', { sessionMode: 'dedicated-window' })).resolves.toBe(true);

    expect(mocked.execCalls.some((args) =>
      args[0] === 'kill-window' && args.includes('leader-session:3'),
    )).toBe(true);
    expect(mocked.execCalls.some((args) => args[0] === 'kill-pane')).toBe(false);
  });

  it('uses only recorded worker panes during split-pane shutdown', async () => {
    mocked.listedPanes = '%10\n%11\n%12\n';

    const paneIds = await resolveSplitPaneWorkerPaneIds('leader-session:0', ['%11'], '%10');

    expect(paneIds).toEqual(['%11']);
    expect(mocked.execCalls.some((args) => args[0] === 'list-panes')).toBe(false);
  });

  it('preserves a recorded worker pane when target membership cannot be proven', async () => {
    mocked.listedPanes = '%10\n';

    await expect(killTeamSession('leader-session:0', ['%11'], '%10')).resolves.toBe(false);

    expect(mocked.execCalls.some((args) => args[0] === 'kill-pane' && args.includes('%11'))).toBe(false);
  });
});
