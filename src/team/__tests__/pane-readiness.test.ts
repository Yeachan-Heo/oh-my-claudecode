import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  paneLooksReady,
  paneHasActiveTask,
} from '../tmux-session.js';

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================
// waitForPaneReady unit tests (mocked tmux)
// ============================================================

describe('waitForPaneReady', () => {
  it('returns true immediately when pane is already ready', async () => {
    const readyCapture = '\n❯ \n';

    vi.doMock('child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('child_process')>();
      const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');
      const execFileMock = vi.fn((_cmd: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        if (args[0] === 'capture-pane') {
          cb(null, readyCapture, '');
        } else {
          cb(null, '', '');
        }
        return {} as never;
      });
      (execFileMock as unknown as Record<symbol, unknown>)[promisifyCustom] =
        async (_cmd: string, args: string[]) => {
          if (args[0] === 'capture-pane') return { stdout: readyCapture, stderr: '' };
          return { stdout: '', stderr: '' };
        };
      return { ...actual, execFile: execFileMock };
    });

    const { waitForPaneReady } = await import('../tmux-session.js');
    const result = await waitForPaneReady('%99', { timeoutMs: 2000, pollIntervalMs: 100 });
    expect(result).toBe(true);

    vi.doUnmock('child_process');
  });

  it('returns false on timeout when pane never becomes ready', async () => {
    const notReadyCapture = '\nloading...\n';

    vi.doMock('child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('child_process')>();
      const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');
      const execFileMock = vi.fn((_cmd: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        if (args[0] === 'capture-pane') {
          cb(null, notReadyCapture, '');
        } else {
          cb(null, '', '');
        }
        return {} as never;
      });
      (execFileMock as unknown as Record<symbol, unknown>)[promisifyCustom] =
        async (_cmd: string, args: string[]) => {
          if (args[0] === 'capture-pane') return { stdout: notReadyCapture, stderr: '' };
          return { stdout: '', stderr: '' };
        };
      return { ...actual, execFile: execFileMock };
    });

    const { waitForPaneReady } = await import('../tmux-session.js');
    const result = await waitForPaneReady('%99', { timeoutMs: 600, pollIntervalMs: 100 });
    expect(result).toBe(false);

    vi.doUnmock('child_process');
  });

  it('returns true once pane becomes ready after initial non-ready state', async () => {
    let callCount = 0;

    vi.doMock('child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('child_process')>();
      const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');
      const execFileMock = vi.fn((_cmd: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        if (args[0] === 'capture-pane') {
          callCount++;
          const capture = callCount >= 3 ? '\n❯ \n' : '\nloading...\n';
          cb(null, capture, '');
        } else {
          cb(null, '', '');
        }
        return {} as never;
      });
      (execFileMock as unknown as Record<symbol, unknown>)[promisifyCustom] =
        async (_cmd: string, args: string[]) => {
          if (args[0] === 'capture-pane') {
            callCount++;
            const capture = callCount >= 3 ? '\n❯ \n' : '\nloading...\n';
            return { stdout: capture, stderr: '' };
          }
          return { stdout: '', stderr: '' };
        };
      return { ...actual, execFile: execFileMock };
    });

    const { waitForPaneReady } = await import('../tmux-session.js');
    const result = await waitForPaneReady('%99', { timeoutMs: 5000, pollIntervalMs: 100 });
    expect(result).toBe(true);
    expect(callCount).toBeGreaterThanOrEqual(3);

    vi.doUnmock('child_process');
  });
});

// ============================================================
// TOCTOU mitigation: sendToWorker pre-injection copy-mode re-check
// ============================================================

describe('sendToWorker TOCTOU mitigation', () => {
  const source = readFileSync(join(__dirname, '..', 'tmux-session.ts'), 'utf-8');

  it('re-checks copy-mode right before text injection', () => {
    // Verify that between trust prompt handling and text injection,
    // there is a copy-mode re-check to close the TOCTOU gap
    expect(source).toContain('Re-verify pane state right before text injection (TOCTOU mitigation)');
    expect(source).toContain('pane may have entered copy-mode or changed state since the initial check');
  });

  it('has copy-mode check between trust prompt handling and send-keys literal', () => {
    // The re-check must appear AFTER the trust prompt block and BEFORE the literal send-keys
    const trustPromptIdx = source.indexOf('paneHasTrustPrompt(initialCapture)');
    const reVerifyIdx = source.indexOf('Re-verify pane state right before text injection');
    const sendKeysLiteralIdx = source.indexOf("Send text in literal mode with -- separator");

    expect(trustPromptIdx).toBeGreaterThan(-1);
    expect(reVerifyIdx).toBeGreaterThan(trustPromptIdx);
    expect(sendKeysLiteralIdx).toBeGreaterThan(reVerifyIdx);
  });
});

// ============================================================
// spawnWorkerForTask: waitForPaneReady replaces blind wait
// ============================================================

describe('spawnWorkerForTask readiness check', () => {
  const runtimeSource = readFileSync(join(__dirname, '..', 'runtime.ts'), 'utf-8');

  it('uses waitForPaneReady instead of blind setTimeout', () => {
    expect(runtimeSource).toContain('waitForPaneReady');
    expect(runtimeSource).toContain('worker_pane_not_ready');
    // The blind 4-second wait should no longer exist
    expect(runtimeSource).not.toContain('setTimeout(r, 4000)');
  });

  it('imports waitForPaneReady from tmux-session', () => {
    // The import may span multiple lines; check both the symbol and the source module
    expect(runtimeSource).toContain('waitForPaneReady');
    // Find the import block that contains both waitForPaneReady and tmux-session
    const importBlock = runtimeSource.slice(0, runtimeSource.indexOf("} from './tmux-session.js'") + 30);
    expect(importBlock).toContain('waitForPaneReady');
    expect(importBlock).toContain('tmux-session');
  });

  it('cleans up pane and resets task on readiness timeout', () => {
    // After waitForPaneReady returns false, spawnWorkerForTask should:
    // 1. Kill the worker pane
    // 2. Reset the task to pending
    // 3. Throw an error
    const readinessBlock = runtimeSource.slice(
      runtimeSource.indexOf('waitForPaneReady(paneId'),
      runtimeSource.indexOf('worker_pane_not_ready') + 50
    );
    expect(readinessBlock).toContain('killWorkerPane');
    expect(readinessBlock).toContain('resetTaskToPending');
    expect(readinessBlock).toContain('worker_pane_not_ready');
  });
});

// ============================================================
// paneLooksReady: verify detection patterns
// ============================================================

describe('paneLooksReady detection patterns', () => {
  it('detects standard prompt characters', () => {
    expect(paneLooksReady('user@host:~$ \n❯ ')).toBe(true);
    expect(paneLooksReady('some output\n> ')).toBe(true);
    expect(paneLooksReady('line1\n› ')).toBe(true);
  });

  it('detects Codex readiness hint', () => {
    expect(paneLooksReady('gpt-5.3-codex high\n80% left')).toBe(true);
  });

  it('rejects empty or loading captures', () => {
    expect(paneLooksReady('')).toBe(false);
    expect(paneLooksReady('loading...\nplease wait')).toBe(false);
  });

  it('rejects capture with only whitespace lines', () => {
    expect(paneLooksReady('\n\n   \n\n')).toBe(false);
  });
});

// ============================================================
// paneHasActiveTask: verify detection patterns
// ============================================================

describe('paneHasActiveTask detection patterns', () => {
  it('detects active task by "esc to interrupt"', () => {
    expect(paneHasActiveTask('working...\nesc to interrupt\n')).toBe(true);
  });

  it('detects active task by "background terminal running"', () => {
    expect(paneHasActiveTask('processing\nbackground terminal running\n')).toBe(true);
  });

  it('returns false for idle pane', () => {
    expect(paneHasActiveTask('❯ \nready\n')).toBe(false);
  });
});
