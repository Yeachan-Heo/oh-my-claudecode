import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

const runnerPath = resolve(__dirname, '../../../../scripts/run.cjs');
const runnerRequire = createRequire(runnerPath);
const runnerSource = readFileSync(runnerPath, 'utf8');
const { resolveGenericTimeoutMs } = runnerRequire(runnerPath) as {
  resolveGenericTimeoutMs: (hook: { event: string; timeoutMs: number }) => number;
};

// Execute the actual CLI budget branch, isolating process startup and worker I/O.
function startForeground(timeoutMs: number, env: Record<string, string> = {}) {
  const module = { exports: {} };
  const require = Object.assign((id: string) => runnerRequire(id), { main: module });
  const expired = vi.fn();
  const runWorker = vi.fn((_target: string, _hook: unknown, budgetMs: number) =>
    new Promise<number>((done) => setTimeout(() => {
      expired();
      done(0);
    }, budgetMs)));
  const source = runnerSource.replace('\nif (require.main === module) {', `
    ensureProcessDestGuards = () => {};
    resolveTarget = () => ({ targetPath: 'session-end.mjs' });
    resolveWorkerTarget = () => null;
    resolveTrustedSessionEndTarget = () => testManifestHook;
    runWorker = testRunWorker;
    if (require.main === module) {
  `);
  runInNewContext(`(function () {\n${source.replace(/^#![^\n]*\n/, '')}\n})();`, {
    require,
    module,
    process: { argv: ['node', runnerPath, 'session-end.mjs'], env, platform: process.platform },
    testManifestHook: { event: 'SessionEnd', timeoutMs },
    testRunWorker: runWorker,
  }, { filename: runnerPath });
  return { expired, budgetMs: runWorker.mock.calls[0][2] };
}

describe('SessionEnd runner foreground budget (issue #4844)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('allows cold startup beyond 300ms and scales with the manifest timeout', async () => {
    const short = startForeground(10_000);
    const long = startForeground(30_000);
    expect(short.budgetMs).toBeGreaterThanOrEqual(1000);
    expect(long.budgetMs).toBeGreaterThan(short.budgetMs);
    expect(long.budgetMs).toBeLessThanOrEqual(resolveGenericTimeoutMs({ event: 'SessionEnd', timeoutMs: 30_000 }));
    await vi.advanceTimersByTimeAsync(300);
    expect(short.expired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(short.budgetMs - 300);
    expect(short.expired).toHaveBeenCalledOnce();
    expect(long.expired).not.toHaveBeenCalled();
  });

  it('provides a 1000ms cold-start floor when the manifest permits it', () => {
    expect(startForeground(2000).budgetMs).toBe(1000);
  });

  it('preserves the test-only timeout override', async () => {
    const foreground = startForeground(30_000, {
      NODE_ENV: 'test', OMC_SESSION_END_TEST_FOREGROUND_TIMEOUT_MS: '450',
    });
    expect(foreground.budgetMs).toBe(450);
    await vi.advanceTimersByTimeAsync(449);
    expect(foreground.expired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(foreground.expired).toHaveBeenCalledOnce();
  });

  it('ignores the test override outside NODE_ENV=test', () => {
    const baseline = startForeground(30_000).budgetMs;
    expect(startForeground(30_000, {
      NODE_ENV: 'production', OMC_SESSION_END_TEST_FOREGROUND_TIMEOUT_MS: '450',
    }).budgetMs).toBe(baseline);
  });

  it.each(['0', '-1', 'NaN', 'Infinity'])('ignores invalid test override %s', (value) => {
    expect(startForeground(30_000, {
      NODE_ENV: 'test', OMC_SESSION_END_TEST_FOREGROUND_TIMEOUT_MS: value,
    }).budgetMs).toBe(startForeground(30_000).budgetMs);
  });

  it('caps even a test override at the manifest-derived timeout', () => {
    expect(startForeground(2000, {
      NODE_ENV: 'test', OMC_SESSION_END_TEST_FOREGROUND_TIMEOUT_MS: '99999',
    }).budgetMs).toBe(resolveGenericTimeoutMs({ event: 'SessionEnd', timeoutMs: 2000 }));
  });
});
