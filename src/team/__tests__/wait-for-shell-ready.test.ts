import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

/**
 * Shared mock state for capture-pane call tracking.
 * Each entry in `captureResults` is either a string (success stdout) or an Error (rejection).
 */
const mockedState = vi.hoisted(() => ({
  execFileArgs: [] as string[][],
  captureResults: [] as Array<string | Error>,
  captureCallCount: 0,
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const { promisify: realPromisify } = await import('util');

  const mockExecFile = vi.fn((_cmd: string, args: string[], cb: ExecFileCallback) => {
    mockedState.execFileArgs.push(args);
    if (args[0] === 'capture-pane') {
      const entry = mockedState.captureResults[mockedState.captureCallCount];
      mockedState.captureCallCount++;
      if (entry instanceof Error) {
        cb(entry, '', '');
      } else {
        cb(null, entry ?? '', '');
      }
    } else {
      cb(null, '', '');
    }
    return {} as never;
  });

  // Set the custom promisify symbol so promisify(execFile) returns {stdout, stderr}
  // just like the real node execFile does.
  (mockExecFile as any)[realPromisify.custom] = (cmd: string, args: string[]) => {
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      mockExecFile(cmd, args, ((err: Error | null, stdout: string, stderr: string) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      }) as ExecFileCallback);
    });
  };

  return {
    ...actual,
    execFile: mockExecFile,
  };
});

import { waitForShellReady, spawnWorkerInPane } from '../tmux-session.js';

function resetMock() {
  mockedState.execFileArgs = [];
  mockedState.captureResults = [];
  mockedState.captureCallCount = 0;
}

describe('waitForShellReady', () => {
  beforeEach(resetMock);

  it('returns true immediately when prompt is already visible', async () => {
    mockedState.captureResults = ['user@host:~$ '];

    const result = await waitForShellReady('%5', { intervalMs: 10, timeoutMs: 500 });

    expect(result).toBe(true);
    expect(mockedState.captureCallCount).toBe(1);
    const captureCall = mockedState.execFileArgs.find(
      (args) => args[0] === 'capture-pane'
    );
    expect(captureCall).toContain('%5');
  });

  it('polls until prompt appears', async () => {
    mockedState.captureResults = ['', '\n\n', 'user@host:~$ '];

    const result = await waitForShellReady('%5', { intervalMs: 10, timeoutMs: 2000 });

    expect(result).toBe(true);
    expect(mockedState.captureCallCount).toBe(3);
  });

  it('returns false on timeout when no prompt appears', async () => {
    mockedState.captureResults = Array(100).fill('loading...');

    const result = await waitForShellReady('%5', { intervalMs: 10, timeoutMs: 100 });

    expect(result).toBe(false);
  });

  it('detects various prompt characters', async () => {
    const prompts = ['$ ', '# ', '% ', '> ', '❯ ', '› '];
    for (const prompt of prompts) {
      mockedState.captureCallCount = 0;
      mockedState.captureResults = [`some-output\nuser@host${prompt}`];
      const result = await waitForShellReady('%5', { intervalMs: 10, timeoutMs: 500 });
      expect(result).toBe(true);
    }
  });

  it('accepts custom prompt pattern', async () => {
    mockedState.captureResults = ['my-custom-prompt>>> '];

    const result = await waitForShellReady('%5', {
      intervalMs: 10,
      timeoutMs: 500,
      promptPattern: />>>\s*$/,
    });

    expect(result).toBe(true);
  });

  it('handles capture-pane errors gracefully and keeps polling', async () => {
    mockedState.captureResults = [
      new Error('pane not found'),
      'user@host:~$ ',
    ];

    const result = await waitForShellReady('%5', { intervalMs: 10, timeoutMs: 2000 });

    expect(result).toBe(true);
    expect(mockedState.captureCallCount).toBe(2);
  });
});

describe('spawnWorkerInPane with waitForShell', () => {
  beforeEach(resetMock);

  it('waits for shell ready by default before sending keys', async () => {
    mockedState.captureResults = ['user@host:~$ '];

    await spawnWorkerInPane('session:0', '%2', {
      teamName: 'safe-team',
      workerName: 'worker-1',
      envVars: { OMC_TEAM_NAME: 'safe-team' },
      launchBinary: 'codex',
      launchArgs: ['--full-auto'],
      cwd: '/tmp',
    }, { shellReadyOpts: { timeoutMs: 500, intervalMs: 10 } });

    // capture-pane was called before send-keys
    const captureIndex = mockedState.execFileArgs.findIndex(
      (args) => args[0] === 'capture-pane'
    );
    const sendKeysIndex = mockedState.execFileArgs.findIndex(
      (args) => args[0] === 'send-keys' && args.includes('-l')
    );
    expect(captureIndex).toBeGreaterThanOrEqual(0);
    expect(sendKeysIndex).toBeGreaterThan(captureIndex);
  });

  it('skips shell ready wait when waitForShell is false', async () => {
    await spawnWorkerInPane('session:0', '%2', {
      teamName: 'safe-team',
      workerName: 'worker-1',
      envVars: { OMC_TEAM_NAME: 'safe-team' },
      launchBinary: 'codex',
      launchArgs: ['--full-auto'],
      cwd: '/tmp',
    }, { waitForShell: false });

    const captureCalls = mockedState.execFileArgs.filter(
      (args) => args[0] === 'capture-pane'
    );
    expect(captureCalls).toHaveLength(0);

    // send-keys should still have been called (literal + Enter)
    const sendKeysCalls = mockedState.execFileArgs.filter(
      (args) => args[0] === 'send-keys'
    );
    expect(sendKeysCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('proceeds with send-keys even if shell ready times out', async () => {
    mockedState.captureResults = Array(100).fill('loading...');

    await spawnWorkerInPane('session:0', '%2', {
      teamName: 'safe-team',
      workerName: 'worker-1',
      envVars: { OMC_TEAM_NAME: 'safe-team' },
      launchBinary: 'codex',
      launchArgs: ['--full-auto'],
      cwd: '/tmp',
    }, { shellReadyOpts: { timeoutMs: 50, intervalMs: 10 } });

    const sendKeysCalls = mockedState.execFileArgs.filter(
      (args) => args[0] === 'send-keys' && args.includes('-l')
    );
    expect(sendKeysCalls).toHaveLength(1);
  });

  it('logs a warning when shell ready times out', async () => {
    mockedState.captureResults = Array(100).fill('loading...');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await spawnWorkerInPane('session:0', '%2', {
      teamName: 'safe-team',
      workerName: 'worker-1',
      envVars: { OMC_TEAM_NAME: 'safe-team' },
      launchBinary: 'codex',
      launchArgs: ['--full-auto'],
      cwd: '/tmp',
    }, { shellReadyOpts: { timeoutMs: 50, intervalMs: 10 } });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('spawnWorkerInPane: shell in pane %2 did not become ready')
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('OMC_SHELL_READY_TIMEOUT_MS')
    );
    warnSpy.mockRestore();
  });
});

describe('waitForShellReady timeout configuration', () => {
  const originalEnv = process.env.OMC_SHELL_READY_TIMEOUT_MS;

  beforeEach(() => {
    resetMock();
    delete process.env.OMC_SHELL_READY_TIMEOUT_MS;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.OMC_SHELL_READY_TIMEOUT_MS = originalEnv;
    } else {
      delete process.env.OMC_SHELL_READY_TIMEOUT_MS;
    }
  });

  it('uses OMC_SHELL_READY_TIMEOUT_MS env var when opts.timeoutMs is not set', async () => {
    process.env.OMC_SHELL_READY_TIMEOUT_MS = '50';
    mockedState.captureResults = Array(100).fill('loading...');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await waitForShellReady('%5', { intervalMs: 10 });

    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('timed out after 50ms')
    );
    warnSpy.mockRestore();
  });

  it('opts.timeoutMs takes precedence over env var', async () => {
    process.env.OMC_SHELL_READY_TIMEOUT_MS = '5000';
    mockedState.captureResults = Array(100).fill('loading...');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await waitForShellReady('%5', { intervalMs: 10, timeoutMs: 50 });

    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('timed out after 50ms')
    );
    warnSpy.mockRestore();
  });

  it('ignores invalid env var values', async () => {
    process.env.OMC_SHELL_READY_TIMEOUT_MS = 'not-a-number';
    mockedState.captureResults = ['user@host:~$ '];

    const result = await waitForShellReady('%5', { intervalMs: 10 });

    // Falls back to 10_000 default; prompt found immediately
    expect(result).toBe(true);
  });

  it('ignores non-positive env var values', async () => {
    process.env.OMC_SHELL_READY_TIMEOUT_MS = '-100';
    mockedState.captureResults = ['user@host:~$ '];

    const result = await waitForShellReady('%5', { intervalMs: 10 });

    expect(result).toBe(true);
  });
});

describe('waitForShellReady progressive backoff', () => {
  beforeEach(resetMock);

  it('polls fewer times with backoff than fixed interval for same timeout', async () => {
    // With 200ms initial interval and 1000ms timeout, fixed interval would do ~5 polls.
    // With 1.5x backoff (200, 300, 450, 675), fewer polls are needed.
    mockedState.captureResults = Array(100).fill('loading...');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await waitForShellReady('%5', { intervalMs: 200, timeoutMs: 1000 });

    // With backoff: 200 + 300 + 450 = 950ms (3 polls before timeout)
    // Without backoff: 200*5 = 1000ms (5 polls)
    expect(mockedState.captureCallCount).toBeLessThanOrEqual(4);
    expect(mockedState.captureCallCount).toBeGreaterThanOrEqual(2);
    warnSpy.mockRestore();
  });

  it('logs a warning with pane ID on timeout', async () => {
    mockedState.captureResults = Array(100).fill('loading...');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await waitForShellReady('%42', { intervalMs: 10, timeoutMs: 50 });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('pane %42')
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('timed out after 50ms')
    );
    warnSpy.mockRestore();
  });

  it('does not log warning when prompt is found before timeout', async () => {
    mockedState.captureResults = ['', 'user@host:~$ '];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await waitForShellReady('%5', { intervalMs: 10, timeoutMs: 500 });

    expect(result).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
