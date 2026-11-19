import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type TraceCase = {
  case: string;
  eventState?: string | null;
  env: Record<string, string | null>;
  control: boolean;
  keys: Array<{ fn: string; pane: string; guarded: boolean; keys: string[]; at_ms: number }>;
  result: unknown;
  wait_ms: number;
  unknown_commands: string[];
};
type Trace = { set: string; loaded_modules: string[]; cases: TraceCase[] };
type Summarize = (input: { set: string; baseSha: string; headSha: string; base: Trace; head: Trace }) => string;

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'dev', 'readiness-diff.mjs');
const { summarize } = await import(pathToFileURL(SCRIPT).href) as { summarize: Summarize };

const send = (keys: string[]) => ({ fn: 'tmuxCmdAsync', pane: '%2', guarded: true, keys, at_ms: 0 });

function traceCase(raw: string | null, waitMs: number): TraceCase {
  return {
    case: `claude/2.1.325/idle.txt OMC_TEAM_READY_TIMEOUT_MS=${raw ?? '<unset>'}`,
    env: { OMC_TEAM_READY_TIMEOUT_MS: raw },
    control: raw === null,
    keys: [send(['-l', 'Read inbox.md']), send(['Enter']), send(['Enter'])],
    result: { ok: true, kind: 'attempted_unconfirmed' },
    wait_ms: waitMs,
    unknown_commands: [],
  };
}

function trace(cases: TraceCase[]): Trace {
  return { set: 'r5', loaded_modules: ['tmux-session'], cases };
}

function run(head: Trace): string {
  const base = trace([traceCase(null, 1_000), traceCase('60000', 1_000)]);
  return summarize({ set: 'r5', baseSha: 'base', headSha: 'head', base, head });
}

describe('readiness-diff set r5', () => {
  it('passes when head sends the same keys and only waits longer for a value >= 30000', () => {
    const summary = run(trace([traceCase(null, 1_000), traceCase('60000', 40_000)]));
    expect(summary).toMatch(/RESULT PASS$/);
  });

  it('fails when head drops one key and nothing else changes', () => {
    const shorter = traceCase('60000', 1_000);
    shorter.keys.pop();
    const summary = run(trace([traceCase(null, 1_000), shorter]));
    expect(summary).toContain('failure: claude/2.1.325/idle.txt OMC_TEAM_READY_TIMEOUT_MS=60000 key sequence differs from base');
    expect(summary).toMatch(/RESULT FAIL$/);
  });

  it('fails when head changes only the return value', () => {
    const changed = traceCase('60000', 1_000);
    changed.result = { ok: false, reason: 'capture_failed' };
    const summary = run(trace([traceCase(null, 1_000), changed]));
    expect(summary).toContain('failure: claude/2.1.325/idle.txt OMC_TEAM_READY_TIMEOUT_MS=60000 result differs from base');
    expect(summary).toMatch(/RESULT FAIL$/);
  });

  it('fails when head waits past 120000ms', () => {
    const summary = run(trace([traceCase(null, 1_000), traceCase('60000', 120_001)]));
    expect(summary).toMatch(/RESULT FAIL$/);
  });

  it.each(['base', 'head'] as const)('fails when the %s run has an unrecognized tmux command', side => {
    const odd = traceCase('60000', 1_000);
    odd.unknown_commands = ['tmuxCmdAsync: ["swap-pane"]'];
    const base = trace([traceCase(null, 1_000), side === 'base' ? odd : traceCase('60000', 1_000)]);
    const head = trace([traceCase(null, 1_000), side === 'head' ? odd : traceCase('60000', 1_000)]);
    const summary = summarize({ set: 'r5', baseSha: 'base', headSha: 'head', base, head });
    expect(summary).toContain(`${side} ran 1 unrecognized tmux command(s)`);
    expect(summary).toMatch(/RESULT FAIL$/);
  });

  it.each([
    ['6e4', true],
    ['9007199254740992', false],
  ])('lets %s lengthen the wait only if the product reads it above 30000ms (%s)', (raw, allowed) => {
    const base = trace([traceCase(null, 1_000), traceCase(raw, 1_000)]);
    const head = trace([traceCase(null, 1_000), traceCase(raw, 40_000)]);
    const summary = summarize({ set: 'r5', baseSha: 'base', headSha: 'head', base, head });
    expect(summary).toMatch(allowed ? /RESULT PASS$/ : /RESULT FAIL$/);
  });
});

describe('readiness-diff set trust', () => {
  const TRUST = 'claude/2.1.325/trust.txt';
  const ok = { ok: true, kind: 'attempted_unconfirmed' };
  const persistent = { ok: false, reason: 'selector_persistent' };
  const trustCase = (mode: string, keys: string[][], result: unknown, waitMs: number): TraceCase => ({
    case: `${TRUST} keys=${mode}`,
    eventState: mode,
    env: { OMC_TEAM_READY_TIMEOUT_MS: null },
    control: mode === 'immediate',
    keys: keys.map(send),
    result,
    wait_ms: waitMs,
    unknown_commands: [],
  });
  const delivered = [['Down'], ['Enter'], ['-l', 'Read inbox.md'], ['Enter'], ['Enter']];
  const base = () => ({ set: 'trust', loaded_modules: [], cases: [
    trustCase('immediate', delivered, ok, 470),
    trustCase('batched', [['Down'], ['Enter']], persistent, 250),
    trustCase('stale', [['Down'], ['Enter']], persistent, 250),
  ] });
  const goodHead = () => ({ set: 'trust', loaded_modules: [], cases: [
    trustCase('immediate', delivered, ok, 720),
    trustCase('batched', delivered, ok, 720),
    trustCase('stale', [], persistent, 0),
  ] });
  const runTrust = (head: Trace, baseTrace: Trace = base()) =>
    summarize({ set: 'trust', baseSha: 'base', headSha: 'head', base: baseTrace, head });

  it('passes the fixed behavior', () => {
    expect(runTrust(goodHead())).toMatch(/RESULT PASS$/);
  });

  it('fails when head behaves like base', () => {
    expect(runTrust(base())).toMatch(/RESULT FAIL$/);
  });

  it('fails when batched head still fails', () => {
    const head = goodHead();
    head.cases[1] = trustCase('batched', [['Down']], { ok: false, reason: 'readiness_timeout' }, 30_000);
    expect(runTrust(head)).toContain(`failure: ${TRUST} keys=batched head result`);
  });

  it('fails when immediate keys differ or the wait is not exactly one poll longer', () => {
    const head = goodHead();
    head.cases[0] = trustCase('immediate', [['Enter'], ...delivered.slice(2)], ok, 970);
    const summary = runTrust(head);
    expect(summary).toContain(`failure: ${TRUST} keys=immediate key sequence differs from base`);
    expect(summary).toContain(`failure: ${TRUST} keys=immediate head waited 970ms`);
  });

  it('fails when head sends a key into the live prompt below a stale dialog', () => {
    const head = goodHead();
    head.cases[2] = trustCase('stale', [['Down']], persistent, 250);
    expect(runTrust(head)).toContain(`failure: ${TRUST} keys=stale head sent 1 key(s) into the live prompt`);
  });

  it('fails when a mode has no case', () => {
    const only = (trace: Trace) => ({ ...trace, cases: trace.cases.slice(0, 1) });
    expect(runTrust(only(goodHead()), only(base()))).toContain('failure: no batched case');
  });
});
