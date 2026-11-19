import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type TraceCase = {
  case: string;
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
});
