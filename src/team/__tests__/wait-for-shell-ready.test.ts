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

  const mockExecFile = vi.fn((_cmd: string, args: string[], cbOrOpts: ExecFileCallback | Record<string, unknown>, maybeCb?: ExecFileCallback) => {
    mockedState.execFileArgs.push(args);
    // Support both (cmd, args, cb) and (cmd, args, opts, cb) signatures
    const cb = typeof cbOrOpts === 'function' ? cbOrOpts : maybeCb!;
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
  // just like the real node execFile does. Accepts optional options parameter.
  (mockExecFile as any)[realPromisify.custom] = (cmd: string, args: string[], _options?: Record<string, unknown>) => {
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
  afterEach(() => {
    delete process.env.OMC_SHELL_READY_TIMEOUT_MS;
  });

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

  it('logs a warning on timeout with pane ID and poll count', async () => {
    mockedState.captureResults = Array(100).fill('loading...');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await waitForShellReady('%7', { intervalMs: 10, timeoutMs: 80 });

    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalledOnce();
    const msg = warnSpy.mock.calls[0][0] as string;
    expect(msg).toContain('[waitForShellReady]');
    expect(msg).toContain('%7');
    expect(msg).toContain('80ms');
    expect(msg).toContain('polls');
    expect(msg).toContain('OMC_SHELL_READY_TIMEOUT_MS');
    warnSpy.mockRestore();
  });

  it('does not log a warning when prompt is detected', async () => {
    mockedState.captureResults = ['user@host:~$ '];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await waitForShellReady('%5', { intervalMs: 10, timeoutMs: 500 });

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('uses progressive backoff between polls', async () => {
    // Provide enough results so we can measure timing
    mockedState.captureResults = Array(50).fill('loading...');

    const startTime = Date.now();
    await waitForShellReady('%5', {
      intervalMs: 50,
      maxIntervalMs: 200,
      backoffFactor: 2.0,
      timeoutMs: 500,
    });
    const elapsed = Date.now() - startTime;

    // With backoff: 50 + 100 + 200 + 200 + ... (caps at 200)
    // Without backoff: 50 + 50 + 50 + 50 + ... (many more polls)
    // Backoff should result in fewer polls than fixed-interval
    // With 500ms timeout and backoff starting at 50ms doubling to cap 200ms:
    // intervals: 50, 100, 200, 200 => ~550ms of sleep, so ~4-5 polls
    expect(mockedState.captureCallCount).toBeLessThan(15);
    expect(elapsed).toBeGreaterThanOrEqual(400);
  });

  it('respects OMC_SHELL_READY_TIMEOUT_MS env var override', async () => {
    process.env.OMC_SHELL_READY_TIMEOUT_MS = '50';
    mockedState.captureResults = Array(100).fill('loading...');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const startTime = Date.now();
    const result = await waitForShellReady('%5', { intervalMs: 10 });
    const elapsed = Date.now() - startTime;

    expect(result).toBe(false);
    // Should timeout quickly at ~50ms, not 10s default
    expect(elapsed).toBeLessThan(500);
    expect(warnSpy).toHaveBeenCalledOnce();
    const msg = warnSpy.mock.calls[0][0] as string;
    expect(msg).toContain('50ms');
    warnSpy.mockRestore();
  });

  it('explicit timeoutMs option takes precedence over env var', async () => {
    process.env.OMC_SHELL_READY_TIMEOUT_MS = '5000';
    mockedState.captureResults = Array(100).fill('loading...');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const startTime = Date.now();
    const result = await waitForShellReady('%5', { intervalMs: 10, timeoutMs: 50 });
    const elapsed = Date.now() - startTime;

    expect(result).toBe(false);
    // Should use explicit 50ms, not env var 5000ms
    expect(elapsed).toBeLessThan(500);
    warnSpy.mockRestore();
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

  it('proceeds with send-keys even if shell ready times out (fail-open)', async () => {
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

    const sendKeysCalls = mockedState.execFileArgs.filter(
      (args) => args[0] === 'send-keys' && args.includes('-l')
    );
    expect(sendKeysCalls).toHaveLength(1);

    // Should have logged warnings from both waitForShellReady and spawnWorkerInPane
    expect(warnSpy).toHaveBeenCalled();
    const messages = warnSpy.mock.calls.map(c => c[0] as string);
    expect(messages.some(m => m.includes('[waitForShellReady]'))).toBe(true);
    expect(messages.some(m => m.includes('[spawnWorkerInPane]'))).toBe(true);
    expect(messages.some(m => m.includes('fail-open'))).toBe(true);
    warnSpy.mockRestore();
  });
});
