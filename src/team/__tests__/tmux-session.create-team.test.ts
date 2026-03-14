import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

const mockedCalls = vi.hoisted(() => ({
  execFileArgs: [] as string[][],
  splitCount: 0,
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const runMockExec = (args: string[]): { stdout: string; stderr: string } => {
    mockedCalls.execFileArgs.push(args);

    if (args[0] === 'new-session') {
      return { stdout: 'omc-team-race-team-detached:0 %91\n', stderr: '' };
    }

    if (args[0] === 'new-window') {
      return { stdout: 'omx:5 %99\n', stderr: '' };
    }

    if (args[0] === 'display-message' && args.includes('#S:#I #{pane_id}')) {
      return { stdout: 'fallback:2 %42\n', stderr: '' };
    }

    if (args[0] === 'display-message' && args.includes('#S:#I')) {
      return { stdout: 'omx:4\n', stderr: '' };
    }

    if (args[0] === 'display-message' && args.includes('#{window_width}')) {
      return { stdout: '160\n', stderr: '' };
    }

    if (args[0] === 'split-window') {
      mockedCalls.splitCount += 1;
      return { stdout: `%50${mockedCalls.splitCount}\n`, stderr: '' };
    }

    return { stdout: '', stderr: '' };
  };

  const parseTmuxShellCmd = (cmd: string): string[] | null => {
    const match = cmd.match(/^tmux\s+(.+)$/);
    if (!match) return null;
    // Support both single-quoted (H1 fix) and double-quoted args
    const args = match[1].match(/'([^']*(?:\\.[^']*)*)'|"([^"]*)"/g);
    if (!args) return null;
    return args.map((s) => {
      if (s.startsWith("'")) return s.slice(1, -1).replace(/'\\''/g, "'");
      return s.slice(1, -1);
    });
  };

  const execFileMock = vi.fn((_cmd: string, args: string[], cb: ExecFileCallback) => {
    const { stdout, stderr } = runMockExec(args);
    cb(null, stdout, stderr);
    return {} as never;
  });

  const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');
  (execFileMock as unknown as Record<symbol, unknown>)[promisifyCustom] =
    async (_cmd: string, args: string[]) => runMockExec(args);

  type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;
  const execMock = vi.fn((cmd: string, cb: ExecCallback) => {
    const args = parseTmuxShellCmd(cmd);
    const { stdout, stderr } = args ? runMockExec(args) : { stdout: '', stderr: '' };
    cb(null, stdout, stderr);
    return {} as never;
  });
  (execMock as unknown as Record<symbol, unknown>)[promisifyCustom] =
    async (cmd: string) => {
      const args = parseTmuxShellCmd(cmd);
      return args ? runMockExec(args) : { stdout: '', stderr: '' };
    };

  return {
    ...actual,
    exec: execMock,
    execFile: execFileMock,
  };
});

import { createTeamSession } from '../tmux-session.js';

describe('createTeamSession context resolution', () => {
  beforeEach(() => {
    mockedCalls.execFileArgs = [];
    mockedCalls.splitCount = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('creates a detached session when running outside tmux', async () => {
    vi.stubEnv('TMUX', '');
    vi.stubEnv('TMUX_PANE', '');

    const session = await createTeamSession('race-team', 0, '/tmp');

    const detachedCreateCall = mockedCalls.execFileArgs.find((args) =>
      args[0] === 'new-session' && args.includes('-d') && args.includes('-P'),
    );
    expect(detachedCreateCall).toBeDefined();
    expect(session.leaderPaneId).toBe('%91');
    expect(session.sessionName).toBe('omc-team-race-team-detached:0');
    expect(session.workerPaneIds).toEqual([]);
    expect(session.sessionMode).toBe('detached-session');
  });

  it('anchors context to TMUX_PANE to avoid focus races', async () => {
    vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
    vi.stubEnv('TMUX_PANE', '%732');

    const session = await createTeamSession('race-team', 1, '/tmp');

    const detachedCreateCall = mockedCalls.execFileArgs.find((args) => args[0] === 'new-session');
    expect(detachedCreateCall).toBeUndefined();

    const targetedContextCall = mockedCalls.execFileArgs.find((args) =>
      args[0] === 'display-message'
      && args[1] === '-p'
      && args[2] === '-t'
      && args[3] === '%732'
      && args[4] === '#S:#I',
    );
    expect(targetedContextCall).toBeDefined();

    const fallbackContextCall = mockedCalls.execFileArgs.find((args) =>
      args[0] === 'display-message' && args.includes('#S:#I #{pane_id}'),
    );
    expect(fallbackContextCall).toBeUndefined();

    const firstSplitCall = mockedCalls.execFileArgs.find((args) => args[0] === 'split-window');
    expect(firstSplitCall).toEqual(expect.arrayContaining(['split-window', '-h', '-t', '%732']));
    expect(session.leaderPaneId).toBe('%732');
    expect(session.sessionName).toBe('omx:4');
    expect(session.workerPaneIds).toEqual(['%501']);
    expect(session.sessionMode).toBe('split-pane');
  });

  it('creates a dedicated tmux window when requested', async () => {
    vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
    vi.stubEnv('TMUX_PANE', '%732');

    const session = await createTeamSession('race-team', 1, '/tmp', { newWindow: true });

    const newWindowCall = mockedCalls.execFileArgs.find((args) => args[0] === 'new-window');
    expect(newWindowCall).toEqual(expect.arrayContaining(['new-window', '-d', '-P', '-t', 'omx', '-n', 'omc-race-team']));

    const firstSplitCall = mockedCalls.execFileArgs.find((args) => args[0] === 'split-window');
    expect(firstSplitCall).toEqual(expect.arrayContaining(['split-window', '-h', '-t', '%99']));
    expect(mockedCalls.execFileArgs.some((args) => args[0] === 'select-pane' && args.includes('%99'))).toBe(false);
    expect(session.leaderPaneId).toBe('%99');
    expect(session.sessionName).toBe('omx:5');
    expect(session.workerPaneIds).toEqual(['%501']);
    expect(session.sessionMode).toBe('dedicated-window');
  });
});
