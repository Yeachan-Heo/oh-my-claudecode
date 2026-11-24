import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type TraceCase = {
  case: string;
  fixture?: string;
  eventState?: string | null;
  reference_case?: string;
  keys_on_partial?: number;
  partial_captures?: number;
  env: Record<string, string | null>;
  control: boolean;
  keys: Array<{ fn: string; pane: string; guarded: boolean; keys: string[]; at_ms: number }>;
  result: unknown;
  wait_ms: number;
  unknown_commands: string[];
};
type Trace = { set: string; loaded_modules: string[]; cases: TraceCase[] };
type Summarize = (input: { set: string; baseSha: string; headSha: string; base: Trace; head: Trace; expect?: string }) => string;

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

describe('readiness-diff set r5 on a frozen trust dialog still drawing', () => {
  const frozen = (file: string, side: 'base' | 'head'): TraceCase => ({
    ...traceCase(null, side === 'base' ? 220 : 30_000),
    case: `${file} OMC_TEAM_READY_TIMEOUT_MS=<unset>`,
    control: false,
    fixture: file,
    ...(side === 'head' ? { keys: [], result: { ok: false, reason: 'readiness_timeout' } } : {}),
  });
  const run = (file: string, head: TraceCase = frozen(file, 'head')) => summarize({
    set: 'r5', baseSha: 'base', headSha: 'head',
    base: trace([traceCase(null, 1_000), frozen(file, 'base')]),
    head: trace([traceCase(null, 1_000), head]),
  });

  it.each(['claude/2.1.330/trust-no-choice-partial.txt', 'claude/2.1.330/trust-yes-choice-partial.txt'])(
    'passes %s when head sends no key and times out where base typed into it',
    (file) => {
      expect(run(file)).toMatch(/RESULT PASS$/);
    },
  );

  it('fails when head gives up before its readiness timeout', () => {
    const file = 'claude/2.1.330/trust-no-choice-partial.txt';
    const head = frozen(file, 'head');
    head.wait_ms = 250;
    expect(run(file, head)).toContain('head gave up after 250ms, before its 30000ms timeout');
  });

  it('fails the same difference on any other fixture', () => {
    expect(run('claude/2.1.330/trust-body-partial.txt')).toMatch(/RESULT FAIL$/);
  });

  it('fails when head still sends a key into the frozen frame', () => {
    const file = 'claude/2.1.330/trust-no-choice-partial.txt';
    const head = frozen(file, 'head');
    head.keys = [send(['Enter'])];
    expect(run(file, head)).toContain('head sent 1 key(s) into a trust dialog still drawing');
  });
});

describe('readiness-diff --expect identical', () => {
  it('passes only when every case matches base in keys, result and wait', () => {
    const base = trace([traceCase(null, 1_000), traceCase('60000', 1_000)]);
    const same = summarize({ set: 'r5', baseSha: 'base', headSha: 'head', base, head: base, expect: 'identical' });
    expect(same).toMatch(/RESULT PASS$/);
    const slower = summarize({ set: 'r5', baseSha: 'base', headSha: 'head', base, head: trace([traceCase(null, 1_000), traceCase('60000', 40_000)]), expect: 'identical' });
    expect(slower).toContain('failure: claude/2.1.325/idle.txt OMC_TEAM_READY_TIMEOUT_MS=60000 differs from base');
  });
});

describe('readiness-diff set trust-partial', () => {
  const ok = { ok: true, kind: 'attempted_unconfirmed' };
  const persistent = { ok: false, reason: 'selector_persistent' };
  const delivered = [['Down'], ['Enter'], ['-l', 'Read inbox.md'], ['Enter'], ['Enter']];
  const partialCase = (id: string, state: string, keys: string[][], result: unknown, waitMs: number, onPartial: number): TraceCase => ({
    case: id,
    eventState: state,
    ...(state === 'reference' || state === 'pre-typing-partial' ? {} : { reference_case: 'reference claude/2.1.330/trust.txt' }),
    env: { OMC_TEAM_READY_TIMEOUT_MS: null },
    control: state === 'reference',
    keys: keys.map(send),
    result,
    wait_ms: waitMs,
    unknown_commands: [],
    keys_on_partial: onPartial,
    partial_captures: state === 'reference' ? 0 : 1,
  });
  const base = (): Trace => ({ set: 'trust-partial', loaded_modules: [], cases: [
    partialCase('reference claude/2.1.330/trust.txt', 'reference', delivered, ok, 720, 0),
    partialCase('initial', 'initial-partial', [], persistent, 0, 0),
    partialCase('post-down', 'post-down-partial', [['Down']], persistent, 250, 0),
    partialCase('pre-typing', 'pre-typing-partial', [['-l', 'Read inbox.md']], persistent, 100, 1),
  ] });
  const goodHead = (): Trace => ({ set: 'trust-partial', loaded_modules: [], cases: [
    partialCase('reference claude/2.1.330/trust.txt', 'reference', delivered, ok, 720, 0),
    partialCase('initial', 'initial-partial', delivered, ok, 970, 0),
    partialCase('post-down', 'post-down-partial', delivered, ok, 970, 0),
    partialCase('pre-typing', 'pre-typing-partial', delivered, ok, 720, 0),
  ] });
  const runPartial = (head: Trace) => summarize({ set: 'trust-partial', baseSha: 'base', headSha: 'head', base: base(), head });

  it('passes the fixed behavior', () => {
    expect(runPartial(goodHead())).toMatch(/RESULT PASS$/);
  });

  it('fails when head behaves like base', () => {
    expect(runPartial(base())).toMatch(/RESULT FAIL$/);
  });

  it('fails when head sends a key on a partial frame, even one that succeeds', () => {
    const head = goodHead();
    head.cases[1]!.keys_on_partial = 1;
    expect(runPartial(head)).toContain('failure: initial head sent 1 key(s) on a partial frame');
  });

  it.each([1_220, 720])('fails when head waits %ims, not one poll per partial capture past the reference', (waitMs) => {
    const head = goodHead();
    head.cases[2]!.wait_ms = waitMs;
    expect(runPartial(head)).toContain(`failure: post-down head waited ${waitMs}ms, not 970ms`);
  });

  it('fails when the pre-typing case types another trigger than the reference', () => {
    const head = goodHead();
    head.cases[3]!.keys[2] = send(['-l', '']);
    expect(runPartial(head)).toContain('failure: pre-typing head keys differ from reference claude/2.1.330/trust.txt on base');
  });
});
