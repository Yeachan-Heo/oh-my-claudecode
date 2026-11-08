import { describe, it, expect } from 'vitest';
import {
  createHookDispatcher,
  type HookRegistryEntry,
  type HookHandler,
} from '../index.js';

function entry(partial: Partial<HookRegistryEntry> & { id: string }): HookRegistryEntry {
  return {
    event: 'Stop',
    matcher: '*',
    order: 0,
    entrypoint: 'x.mjs',
    args: [],
    timeoutMs: 1000,
    async: false,
    riskClass: 'advisory',
    failMode: 'fail-open',
    ...partial,
  };
}

const okHandler = (out: Record<string, unknown> = { continue: true }): { handler: HookHandler; dryRun: boolean } => ({
  handler: () => out,
  dryRun: true,
});

describe('hook dispatcher — event parsing and ordering (#3707)', () => {
  it('runs only applicable entries in declared order', async () => {
    const calls: string[] = [];
    const registry = [
      entry({ id: 'Stop:*:c', order: 2 }),
      entry({ id: 'Stop:*:a', order: 0 }),
      entry({ id: 'Stop:*:b', order: 1 }),
      entry({ id: 'PreToolUse:*:other', event: 'PreToolUse' }),
      entry({ id: 'Stop:init:scoped', matcher: 'init' }),
    ];
    const handlers = new Map(
      ['a', 'b', 'c'].map((n) => [
        `Stop:*:${n}`,
        { handler: () => {
            calls.push(n);
            return { continue: true };
          },
          dryRun: true,
        },
      ]),
    );
    const dispatcher = createHookDispatcher(registry, { handlers });
    const result = await dispatcher.dispatch('Stop', {});
    expect(calls).toEqual(['a', 'b', 'c']);
    expect(result.records.map((r) => r.hookId)).toEqual([
      'Stop:*:a',
      'Stop:*:b',
      'Stop:*:c',
    ]);
    // Non-matching matchers are excluded from dispatch entirely.
    expect(result.records.some((r) => r.hookId === 'Stop:init:scoped')).toBe(false);
  });

  it('parses the event once per dispatch and emits structured timing records', async () => {
    const registry = [entry({ id: 'Stop:*:a' }), entry({ id: 'Stop:*:b', order: 1 })];
    const dispatcher = createHookDispatcher(registry, {
      handlers: new Map([
        ['Stop:*:a', okHandler()],
        ['Stop:*:b', okHandler()],
      ]),
    });
    const result = await dispatcher.dispatch('Stop', {});
    for (const record of result.records) {
      expect(record.status).toBe('ok');
      expect(record.durationMs).toBeGreaterThanOrEqual(0);
      expect(record.failMode).toBe('fail-open');
      expect(record.riskClass).toBe('advisory');
    }
  });
});

describe('hook dispatcher — timeout and fail-mode semantics (#3707)', () => {
  it('advisory handlers fail open with a structured diagnostic on error', async () => {
    const registry = [
      entry({ id: 'Stop:*:throws' }),
      entry({ id: 'Stop:*:after', order: 1 }),
    ];
    const dispatcher = createHookDispatcher(registry, {
      handlers: new Map([
        ['Stop:*:throws', {
          handler: () => {
            throw new Error('boom');
          },
          dryRun: true,
        }],
        ['Stop:*:after', okHandler()],
      ]),
    });
    const result = await dispatcher.dispatch('Stop', {});
    const [failed, after] = result.records;
    expect(failed.status).toBe('error');
    expect(failed.errorClass).toBe('Error');
    expect(failed.appliedDecision).toBe('fail-open');
    expect(after.status).toBe('ok'); // fail-open does not stop later hooks
  });

  it('hard-risk handlers fail closed and stop subsequent hooks', async () => {
    const registry = [
      entry({
        id: 'PermissionRequest:Bash:guard',
        event: 'PermissionRequest',
        matcher: 'Bash',
        riskClass: 'security-boundary',
        failMode: 'fail-closed',
      }),
      entry({ id: 'PermissionRequest:Bash:after', event: 'PermissionRequest', matcher: 'Bash', order: 1 }),
    ];
    const dispatcher = createHookDispatcher(registry, {
      handlers: new Map([
        ['PermissionRequest:Bash:guard', {
          handler: () => {
            throw new Error('guard exploded');
          },
          dryRun: true,
        }],
        ['PermissionRequest:Bash:after', okHandler()],
      ]),
    });
    const result = await dispatcher.dispatch('PermissionRequest', { tool_name: 'Bash' });
    expect(result.records).toHaveLength(1); // later hook never ran
    expect(result.records[0].appliedDecision).toBe('fail-closed');
  });

  it('enforces per-hook timeouts with the declared timeout budget', async () => {
    const registry = [entry({ id: 'Stop:*:slow', timeoutMs: 25 })];
    const dispatcher = createHookDispatcher(registry, {
      handlers: new Map([
        ['Stop:*:slow', {
          handler: () => new Promise((resolve) => setTimeout(() => resolve({ continue: true }), 5000)),
          dryRun: true,
        }],
      ]),
    });
    const started = performance.now();
    const result = await dispatcher.dispatch('Stop', {});
    expect(performance.now() - started).toBeLessThan(2000);
    expect(result.records[0].status).toBe('timeout');
    expect(result.records[0].errorClass).toBe('TimeoutError');
    expect(result.records[0].appliedDecision).toBe('fail-open');
  });
});

describe('hook dispatcher — shadow mode cannot change behavior (#3707)', () => {
  it('shadow mode never produces a runtime decision — records only', async () => {
    const registry = [entry({ id: 'Stop:*:blocker' })];
    const dispatcher = createHookDispatcher(registry, {
      handlers: new Map([
        ['Stop:*:blocker', {
          handler: () => ({ continue: false, message: 'would block' }),
          dryRun: true,
        }],
      ]),
    });
    const result = await dispatcher.dispatch('Stop', {});
    expect(result.records[0].appliedDecision).toBe('none');
    // DispatchResult has only event + records, no decision field.
    expect('decision' in result).toBe(false);
    expect('mergedOutput' in result).toBe(false);
  });

  it('shadow mode skips side-effecting (non-dry-run) handlers', async () => {
    let ran = false;
    const registry = [entry({ id: 'Stop:*:sideeffect' })];
    const dispatcher = createHookDispatcher(registry, {
      handlers: new Map([
        ['Stop:*:sideeffect', {
          handler: () => {
            ran = true;
            return { continue: true };
          },
          dryRun: false,
        }],
      ]),
    });
    const result = await dispatcher.dispatch('Stop', {});
    expect(ran).toBe(false);
    expect(result.records[0].status).toBe('skipped');
  });

  it('meets the no-op latency budget (p95 <= 50 ms, plan §6.3)', async () => {
    const registry = [entry({ id: 'Stop:*:a' })];
    const dispatcher = createHookDispatcher(registry, {
      handlers: new Map([['Stop:*:a', okHandler()]]),
    });
    const samples: number[] = [];
    for (let i = 0; i < 100; i++) {
      const started = performance.now();
      // No applicable entries for this event: the no-op fast path.
      await dispatcher.dispatch('PreCompact', {});
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)];
    expect(p95).toBeLessThan(50);
  });

  it('meets the advisory latency budget (p95 <= 200 ms, plan §6.3)', async () => {
    const registry = [entry({ id: 'Stop:*:a' }), entry({ id: 'Stop:*:b', order: 1 })];
    const dispatcher = createHookDispatcher(registry, {
      handlers: new Map([
        ['Stop:*:a', okHandler()],
        ['Stop:*:b', okHandler()],
      ]),
    });
    const samples: number[] = [];
    for (let i = 0; i < 50; i++) {
      const started = performance.now();
      await dispatcher.dispatch('Stop', {});
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)];
    expect(p95).toBeLessThan(200);
  });
});
