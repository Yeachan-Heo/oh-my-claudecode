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

    if (args[0] === 'display-message' && args.includes('#S:#I #{pane_id}')) {
      return { stdout: 'fallback:2 %42\n', stderr: '' };
    }

    if (args[0] === 'display-message' && args.includes('#S:#I')) {
      return { stdout: 'omx:4\n', stderr: '' };
    }

    // Handle pane ID query for detached sessions (issue #1085)
    if (args[0] === 'display-message' && args.includes('#{pane_id}') && !args.includes('#S:#I #{pane_id}')) {
      return { stdout: '%99\n', stderr: '' };
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

  /** Parse a shell command like: tmux "arg1" "arg2" into ['arg1', 'arg2'] */
  const parseTmuxShellCmd = (cmd: string): string[] | null => {
    const match = cmd.match(/^tmux\s+(.+)$/);
    if (!match) return null;
    return match[1].match(/"([^"]*)"/g)?.map(s => s.slice(1, -1)) ?? [];
  };

  const execFileMock = vi.fn((_cmd: string, args: string[], cb: ExecFileCallback) => {
    const { stdout, stderr } = runMockExec(args);
    cb(null, stdout, stderr);
    return {} as never;
  });

  const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');
  (execFileMock as unknown as Record<symbol, unknown>)[promisifyCustom] =
    async (_cmd: string, args: string[]) => runMockExec(args);

  // Mock exec for tmuxAsync shell-routed calls (format strings with #{})
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

  const execFileSyncMock = vi.fn((_cmd: string, args: string[], _opts?: unknown) => {
    mockedCalls.execFileArgs.push(args);
    const { stdout } = runMockExec(args);
    return stdout;
  });

  const execSyncMock = vi.fn((_cmd: string, _opts?: unknown) => {
    // validateTmux() calls execSync('tmux -V', ...) — return a version string
    return 'tmux 3.4';
  });

  return {
    ...actual,
    exec: execMock,
    execFile: execFileMock,
    execFileSync: execFileSyncMock,
    execSync: execSyncMock,
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

  it('anchors context to TMUX_PANE to avoid focus races', async () => {
    vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
    vi.stubEnv('TMUX_PANE', '%732');

    const session = await createTeamSession('race-team', 1, '/tmp');

    const targetedContextCall = mockedCalls.execFileArgs.find(args =>
      args[0] === 'display-message' &&
      args[1] === '-p' &&
      args[2] === '-t' &&
      args[3] === '%732' &&
      args[4] === '#S:#I'
    );
    expect(targetedContextCall).toBeDefined();

    const fallbackContextCall = mockedCalls.execFileArgs.find(args =>
      args[0] === 'display-message' &&
      args.includes('#S:#I #{pane_id}')
    );
    expect(fallbackContextCall).toBeUndefined();

    const firstSplitCall = mockedCalls.execFileArgs.find(args => args[0] === 'split-window');
    expect(firstSplitCall).toEqual(expect.arrayContaining(['split-window', '-h', '-t', '%732']));
    expect(session.leaderPaneId).toBe('%732');
    expect(session.sessionName).toBe('omx:4');
    expect(session.workerPaneIds).toEqual(['%501']);
  });

  it('auto-creates detached tmux session when TMUX is not set (issue #1085)', async () => {
    vi.stubEnv('TMUX', '');
    vi.stubEnv('TMUX_PANE', '');

    const session = await createTeamSession('no-tmux-team', 0, '/tmp');

    // Should have called new-session to create a detached session
    const newSessionCall = mockedCalls.execFileArgs.find(args =>
      args[0] === 'new-session' && args.includes('-d') && args.includes('-s')
    );
    expect(newSessionCall).toBeDefined();
    expect(newSessionCall).toEqual(expect.arrayContaining([
      'new-session', '-d', '-s', 'omc-team-no-tmux-team',
    ]));

    // Should have resolved the leader pane from the new session
    const displayCall = mockedCalls.execFileArgs.find(args =>
      args[0] === 'display-message' &&
      args.includes('-t') &&
      args.includes('omc-team-no-tmux-team') &&
      args.includes('#{pane_id}')
    );
    expect(displayCall).toBeDefined();

    // Session name should be bare (no ':window') for detached sessions
    expect(session.sessionName).not.toContain(':');
    expect(session.sessionName).toBe('omc-team-no-tmux-team');
    expect(session.workerPaneIds).toEqual([]);
  });

  it('throws helpful error when TMUX is not set and tmux is not installed', async () => {
    vi.stubEnv('TMUX', '');
    vi.stubEnv('TMUX_PANE', '');

    // Make execSync throw to simulate tmux not installed
    const { execSync } = await import('child_process');
    (execSync as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('command not found: tmux');
    });

    await expect(createTeamSession('no-tmux-team', 0, '/tmp')).rejects.toThrow(
      /tmux is not available/
    );
  });

  it('creates worker panes in detached session when TMUX is not set (issue #1085)', async () => {
    vi.stubEnv('TMUX', '');
    vi.stubEnv('TMUX_PANE', '');

    const session = await createTeamSession('detached-workers', 2, '/tmp');

    // First split should target the leader pane resolved from the detached session
    const firstSplit = mockedCalls.execFileArgs.find(args =>
      args[0] === 'split-window' && args.includes('-h')
    );
    expect(firstSplit).toBeDefined();
    expect(firstSplit).toEqual(expect.arrayContaining(['-t', '%99']));

    expect(session.sessionName).toBe('omc-team-detached-workers');
    expect(session.workerPaneIds).toHaveLength(2);
  });

  it('falls back to default context discovery when TMUX_PANE is invalid', async () => {
    vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
    vi.stubEnv('TMUX_PANE', 'not-a-pane-id');

    const session = await createTeamSession('race-team', 0, '/tmp');

    const targetedContextCall = mockedCalls.execFileArgs.find(args =>
      args[0] === 'display-message' &&
      args[1] === '-p' &&
      args[2] === '-t' &&
      args[4] === '#S:#I'
    );
    expect(targetedContextCall).toBeUndefined();

    const fallbackContextCall = mockedCalls.execFileArgs.find(args =>
      args[0] === 'display-message' &&
      args[1] === '-p' &&
      args[2] === '#S:#I #{pane_id}'
    );
    expect(fallbackContextCall).toBeDefined();

    expect(session.leaderPaneId).toBe('%42');
    expect(session.sessionName).toBe('fallback:2');
    expect(session.workerPaneIds).toEqual([]);
  });
});
