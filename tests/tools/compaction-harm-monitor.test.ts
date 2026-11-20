// Tests for the compaction harm monitor on synthetic transcripts, compaction journals and probe results.
// The script runs with python3 -I through spawnSync; data lives in a temporary directory.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MONITOR = join(HERE, '..', '..', 'tools', 'diagnostics', 'compaction_harm_monitor.py');
const PROBE = join(HERE, '..', '..', 'tools', 'diagnostics', 'compaction_ask_probe.py');
const UNTIL = '2026-11-15T00:00:00Z';
const Z = 1.959963984540054;

function wilson(k: number, n: number): [number, number] {
  const p = k / n;
  const z2 = Z * Z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const radius = (Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, centre - radius), Math.min(1, centre + radius)];
}

const round4 = (x: number) => Math.round(x * 10000) / 10000;

function at(i: number, offsetSeconds = 0) {
  return new Date(Date.UTC(2026, 10, 14, 12, 0, 0) + (i * 60 + offsetSeconds) * 1000).toISOString().replace('.000Z', 'Z');
}

function writeJsonl(path: string, rows: unknown[]) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function userText(sid: string, ts: string, text: string) {
  return { type: 'user', sessionId: sid, timestamp: ts, message: { role: 'user', content: text } };
}

function stateRow(sid: string, ts: string, text: string) {
  return { type: 'user', sessionId: sid, timestamp: ts, message: { role: 'user', content: [{ type: 'text', text }] } };
}

function assistant(sid: string, ts: string, id: string, content: unknown[]) {
  return { type: 'assistant', sessionId: sid, timestamp: ts, message: { id, role: 'assistant', model: 'test-model', content } };
}

function boundary(uuid: string, ts: string) {
  return { type: 'system', subtype: 'compact_boundary', uuid, timestamp: ts, compactMetadata: { trigger: 'auto', preTokens: 1000, postTokens: 100 } };
}

function apiRequest(sid: string, ts: string) {
  return { type: 'api-request', sessionId: sid, timestamp: ts };
}

function compactRow(ts: string, sid: string, agentId: string | null, result: string) {
  return { event: 'compact', ts, session_id: sid, agent_id: agentId, trigger: 'auto', result };
}

// Calls after the state; kind: empty (thinking only), blank (whitespace text), text, tool.
function call(sid: string, i: number, id: string, kind: string, toolFail: boolean | null = null): unknown[] {
  const ts = at(i, 10);
  if (kind === 'empty') return [assistant(sid, ts, id, [{ type: 'thinking', thinking: 'secret-thought' }])];
  if (kind === 'blank') return [assistant(sid, ts, id, [{ type: 'text', text: ' \n  ' }])];
  if (kind === 'text') return [assistant(sid, ts, id, [{ type: 'text', text: 'ANSWER-SENTINEL done' }])];
  if (kind === 'tool') {
    const rows: unknown[] = [assistant(sid, ts, id, [{ type: 'tool_use', id: `${id}-tool`, name: 'Bash', input: { command: 'ls' } }])];
    if (toolFail !== null) {
      rows.push({ type: 'user', sessionId: sid, timestamp: at(i, 11), message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: `${id}-tool`, content: 'TOOL-RESULT-SENTINEL', ...(toolFail ? { is_error: true } : {}) }] } });
    }
    return rows;
  }
  throw new Error(`unknown call kind ${kind}`);
}

interface Env { dir: string; projects: string; compactLog: string; compactRows: unknown[] }

function makeEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), 'test-harm-monitor-'));
  const projects = join(dir, 'projects');
  mkdirSync(join(projects, '-demo'), { recursive: true });
  return { dir, projects, compactLog: join(dir, 'compaction.jsonl'), compactRows: [] };
}

interface UnitOptions {
  sid?: string; uuid?: string; i: number; request?: string; state?: string; tail?: unknown[];
  log?: string; file?: string; agentId?: string;
}

// One transcript with one boundary: request, boundary, state, api-request, then `tail`.
function addUnit(env: Env, name: string, o: UnitOptions) {
  const sid = o.sid ?? name;
  const request = o.request ?? `Request ${name} concerning ledger-${name} reconciliation`;
  const state = o.state ?? `State: ${request}`;
  const rows = [
    userText(sid, at(o.i, 0), request),
    boundary(o.uuid ?? `uuid-${name}`, at(o.i, 2)),
    stateRow(sid, at(o.i, 3), state),
    apiRequest(sid, at(o.i, 4)),
    ...(o.tail ?? []),
  ];
  const path = o.file ?? (o.agentId
    ? join(env.projects, '-demo', sid, 'subagents', `agent-${o.agentId}.jsonl`)
    : join(env.projects, '-demo', `${name}.jsonl`));
  writeJsonl(path, rows);
  if (o.log) env.compactRows.push(compactRow(at(o.i, 2), sid, o.agentId ?? null, o.log));
  return path;
}

function flushLog(env: Env) {
  writeJsonl(env.compactLog, env.compactRows);
}

function runMonitor(env: Env, extra: string[] = [], withPeriod = true) {
  flushLog(env);
  const period = withPeriod ? ['--to', UNTIL, '--days', '7'] : [];
  return spawnSync('python3', ['-I', MONITOR, '--projects', env.projects, '--compact', env.compactLog, ...period, ...extra],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function monitorJson(env: Env, extra: string[] = [], withPeriod = true) {
  const p = runMonitor(env, [...extra, '--json'], withPeriod);
  expect(p.status, `exit ${p.status}: ${p.stderr}`).toBe(0);
  return JSON.parse(p.stdout);
}

function runProbe(env: Env, name = 'probe.json') {
  flushLog(env);
  const out = join(env.dir, name);
  const p = spawnSync('python3', ['-I', PROBE, '--projects', env.projects, '--compact', env.compactLog,
    '--to', UNTIL, '--days', '7', '--details', '--out', out], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  expect(p.status, `probe exit ${p.status}: ${p.stderr}`).toBe(0);
  return out;
}

function cleanup(env: Env) {
  rmSync(env.dir, { recursive: true, force: true });
}

// n units per [flagged, lost, count]; lost marks units whose state lost the last request.
function addCorrelationUnits(env: Env, spec: Array<[boolean, boolean, number]>) {
  let i = 0;
  for (const [flagged, lost, count] of spec) {
    for (let n = 0; n < count; n += 1, i += 1) {
      const name = `x${i}`;
      const tail = ['empty', 'empty', 'empty'].flatMap((k, m) => call(name, i, `${name}-c${m}`, flagged ? k : 'text'));
      addUnit(env, name, { i, tail, state: lost ? 'Generic continuation without details' : undefined });
    }
  }
}

describe('compaction harm monitor', () => {
  it('empty_series: per-call grouping, reset on text, whitespace text is empty, minimum observation', () => {
    const env = makeEnv();
    try {
      const seq = (sid: string, kinds: string[]) => kinds.flatMap((k, n) => call(sid, 0, `${sid}-c${n}`, k));
      addUnit(env, 'a', { i: 0, tail: seq('a', ['empty', 'empty', 'empty']) }); // flagged
      addUnit(env, 'b', { i: 1, tail: seq('b', ['empty', 'empty', 'text', 'empty', 'empty']) }); // reset by text: run 2
      // thinking row and text row of one call share message.id: the call is not empty
      addUnit(env, 'c', { i: 2, tail: [
        assistant('c', at(2, 10), 'c-m1', [{ type: 'thinking', thinking: 't' }]),
        assistant('c', at(2, 11), 'c-m1', [{ type: 'text', text: 'visible' }]),
        ...call('c', 2, 'c-m2', 'empty'), ...call('c', 2, 'c-m3', 'empty')] });
      addUnit(env, 'd', { i: 3, tail: seq('d', ['empty', 'empty']) }); // two calls: undefined
      addUnit(env, 'e', { i: 4, tail: seq('e', ['blank', 'blank', 'blank']) }); // whitespace-only text: empty
      addUnit(env, 'f', { i: 5, tail: seq('f', ['empty', 'empty', 'tool', 'empty']) }); // tool call resets
      const report = monitorJson(env);
      expect(report.units).toBe(6);
      const group = report.signals.empty_series['host/main'];
      expect([group.units, group.defined, group.flagged]).toEqual([6, 5, 2]);
    } finally {
      cleanup(env);
    }
  });

  it('empty_series: calls seen before the boundary or in the state do not count', () => {
    const env = makeEnv();
    try {
      // m-old appears before the boundary and again after the api-request: not a new call
      const path = addUnit(env, 'g', { i: 0, tail: [] });
      writeJsonl(path, [
        userText('g', at(0, 0), 'Request g concerning ledger-g reconciliation'),
        assistant('g', at(0, 1), 'm-old', [{ type: 'text', text: 'before' }]),
        boundary('uuid-g', at(0, 2)),
        stateRow('g', at(0, 3), 'State: Request g concerning ledger-g reconciliation'),
        apiRequest('g', at(0, 4)),
        assistant('g', at(0, 5), 'm-old', [{ type: 'thinking', thinking: 'x' }]),
        ...call('g', 0, 'g-c1', 'empty'), ...call('g', 0, 'g-c2', 'empty'),
      ]);
      const group = monitorJson(env).signals.empty_series['host/main'];
      expect(group.defined, 'only two new calls: below the minimum observation').toBe(0);
    } finally {
      cleanup(env);
    }
  });

  it('tool_errors: share among the first tool calls, minimum results, window limit', () => {
    const env = makeEnv();
    try {
      const tools = (sid: string, fails: boolean[]) => fails.flatMap((f, n) => call(sid, 0, `${sid}-t${n}`, 'tool', f));
      addUnit(env, 'h', { i: 0, tail: tools('h', [true, true, true, false]) }); // 0.75: flagged
      addUnit(env, 'i', { i: 1, tail: tools('i', [true, false, false, false]) }); // 0.25
      addUnit(env, 'j', { i: 2, tail: tools('j', [true, true]) }); // two results: undefined
      // first 10 tool calls are fine, errors only after the window: share 0
      addUnit(env, 'k', { i: 3, tail: tools('k', [...Array(10).fill(false), true, true]) });
      // tool calls without any recorded result do not count as results
      addUnit(env, 'l', { i: 4, tail: [...tools('l', [true, true]), ...call('l', 4, 'l-x', 'tool', null), ...call('l', 4, 'l-y', 'tool', null)] });
      const group = monitorJson(env).signals.tool_errors['host/main'];
      expect([group.units, group.defined, group.flagged]).toEqual([5, 3, 1]);
    } finally {
      cleanup(env);
    }
  });

  it('fallback_run: run of consecutive fallbacks per thread, jev resets, neutral results ignored', () => {
    const env = makeEnv();
    try {
      const before = (i: number, k: number, sid: string, result: string) => compactRow(at(i, 2 - k * 1000), sid, null, result); // k steps before the unit row
      // thread a: jev then four fallbacks, the unit pairs with the fifth row (run 5)
      env.compactRows.push(before(0, 5, 'a', 'jev'), before(0, 4, 'a', 'fallback'), before(0, 3, 'a', 'fallback'),
        before(0, 2, 'a', 'fallback'), before(0, 1, 'a', 'fallback'));
      addUnit(env, 'a', { i: 0, log: 'fallback', tail: [] });
      // thread c: fallback, shadow (neutral), two fallbacks, unit: run 4
      env.compactRows.push(before(10, 4, 'c', 'fallback'), before(10, 3, 'c', 'shadow'), before(10, 2, 'c', 'fallback'),
        before(10, 1, 'c', 'fallback'));
      addUnit(env, 'c', { i: 10, log: 'fallback', tail: [] });
      // thread b: two fallbacks, jev, unit: run 1
      env.compactRows.push(before(20, 3, 'b', 'fallback'), before(20, 2, 'b', 'fallback'), before(20, 1, 'b', 'jev'));
      addUnit(env, 'b', { i: 20, log: 'fallback', tail: [] });
      addUnit(env, 'j', { i: 30, log: 'jev', tail: [] });
      addUnit(env, 'h', { i: 40, tail: [] });
      const report = monitorJson(env, ['--fallback-run-min', '4']);
      const fb = report.signals.fallback_run;
      expect([fb['fallback/main'].units, fb['fallback/main'].defined, fb['fallback/main'].flagged]).toEqual([3, 3, 2]);
      expect(fb['jev/main'].defined, 'not defined for jev units').toBe(0);
      expect(fb['host/main'].defined, 'not defined for host units').toBe(0);
      const strict = monitorJson(env); // default minimum 5
      expect(strict.signals.fallback_run['fallback/main'].flagged).toBe(1);
    } finally {
      cleanup(env);
    }
  });

  it('units and groups equal the probe: jev, fallback, host, subagent, duplicate uuid', () => {
    const env = makeEnv();
    try {
      addUnit(env, 'u1', { i: 0, log: 'jev', tail: call('u1', 0, 'u1-c', 'text') });
      addUnit(env, 'u2', { i: 1, log: 'fallback', tail: call('u2', 1, 'u2-c', 'text') });
      addUnit(env, 'u3', { i: 2, tail: call('u3', 2, 'u3-c', 'text') });
      addUnit(env, 'u4', { i: 3, sid: 'sess4', agentId: 'abc', log: 'jev', tail: call('sess4', 3, 'u4-c', 'text') });
      addUnit(env, 'u5', { i: 4, tail: call('u5', 4, 'u5-c', 'text') });
      addUnit(env, 'u5copy', { i: 4, sid: 'u5', uuid: 'uuid-u5', tail: call('u5', 4, 'u5-c', 'text') }); // same uuid, second file
      const probeFile = runProbe(env);
      const probe = JSON.parse(readFileSync(probeFile, 'utf8'));
      const report = monitorJson(env, ['--probe', probeFile], false);
      expect(report.probe).toEqual({ units: probe.units.length, monitor_only: 0, probe_only: 0, group_mismatch: 0, without_level: 0 });
      expect(report.units).toBe(probe.units.length);
      const expected: Record<string, number> = {};
      for (const u of probe.units) expected[u.group] = (expected[u.group] ?? 0) + 1;
      const actual = Object.fromEntries(Object.entries(report.signals.empty_series).map(([g, v]) => [g, (v as { units: number }).units]));
      expect(actual).toEqual(expected);
      expect(Object.keys(expected).sort()).toEqual(['fallback/main', 'host/main', 'jev/main', 'jev/subagent']);
    } finally {
      cleanup(env);
    }
  });

  it('correlation: counts, agreement with Wilson bounds, selective and per-query bases', () => {
    const env = makeEnv();
    try {
      // [flagged, lost, count]: tp 16, fp 4, fn 2, tn 18
      addCorrelationUnits(env, [[true, true, 16], [true, false, 4], [false, true, 2], [false, false, 18]]);
      const probeFile = runProbe(env);
      const report = monitorJson(env, ['--probe', probeFile], false);
      expect(report.probe.monitor_only + report.probe.probe_only + report.probe.group_mismatch).toBe(0);
      const corr = report.signals.empty_series['host/main'].correlation;
      expect([corr.n, corr.tp, corr.fp, corr.fn, corr.tn]).toEqual([40, 16, 4, 2, 18]);
      const [low, high] = wilson(34, 40);
      expect(corr.agreement).toEqual({ k: 34, n: 40, rate: 0.85, wilson_low: round4(low), wilson_high: round4(high) });
      expect(corr.selective.rate).toBe(0.8);
      expect(corr.per_query.rate).toBe(0.4);
      expect(corr.verdict).toBe('correlated');
    } finally {
      cleanup(env);
    }
  });

  it('correlation: a signal that never fires is dropped although raw agreement is high', () => {
    const env = makeEnv();
    try {
      addCorrelationUnits(env, [[false, true, 3], [false, false, 37]]);
      const corr = monitorJson(env, ['--probe', runProbe(env)], false).signals.empty_series['host/main'].correlation;
      expect(corr.n).toBe(40);
      expect(corr.agreement.rate).toBe(0.925);
      expect(corr.verdict).toBe('no correlation');
    } finally {
      cleanup(env);
    }
  });

  it('correlation: overlapping arms are dropped', () => {
    const env = makeEnv();
    try {
      addCorrelationUnits(env, [[true, true, 5], [true, false, 10], [false, true, 5], [false, false, 20]]);
      const corr = monitorJson(env, ['--probe', runProbe(env)], false).signals.empty_series['host/main'].correlation;
      expect(corr.verdict).toBe('no correlation');
    } finally {
      cleanup(env);
    }
  });

  it('correlation: fewer than 30 joined units gives "no threshold" and hides rates', () => {
    const env = makeEnv();
    try {
      addCorrelationUnits(env, [[true, true, 10], [false, false, 19]]);
      const report = monitorJson(env, ['--probe', runProbe(env)], false);
      const corr = report.signals.empty_series['host/main'].correlation;
      expect(corr.n).toBe(29);
      expect(corr.verdict).toBe('no threshold');
      expect(corr.agreement).toBeNull();
      expect(corr.selective).toBeNull();
      expect(corr.per_query).toBeNull();
      expect(corr.tp, 'counts stay visible').toBe(10);
      const text = runMonitor(env, ['--probe', join(env.dir, 'probe.json')], false);
      expect(text.status).toBe(0);
      expect(text.stdout).toMatch(/verdict: no threshold/);
    } finally {
      cleanup(env);
    }
  });

  it('output carries numbers only: no transcript text, keys or paths in text and JSON modes', () => {
    const env = makeEnv();
    try {
      addUnit(env, 'p1', { i: 0, uuid: 'UUID-SENTINEL-1', log: 'jev', request: 'REQUEST-SENTINEL one two three',
        state: 'STATE-SENTINEL nothing else', tail: [...call('p1', 0, 'p1-a', 'text'), ...call('p1', 0, 'p1-b', 'tool', true),
          ...call('p1', 0, 'p1-c', 'empty')] });
      const probeFile = runProbe(env);
      for (const extra of [[], ['--json']]) {
        const p = runMonitor(env, ['--probe', probeFile, ...extra], false);
        expect(p.status, p.stderr).toBe(0);
        const all = p.stdout + p.stderr;
        for (const secret of ['REQUEST-SENTINEL', 'STATE-SENTINEL', 'ANSWER-SENTINEL', 'TOOL-RESULT-SENTINEL', 'secret-thought',
          'UUID-SENTINEL', env.dir, 'p1.jsonl']) {
          expect(all.includes(secret), `output must not contain ${secret}`).toBe(false);
        }
      }
    } finally {
      cleanup(env);
    }
  });

  it('probe handling: adopts the probe period, refuses a different one, needs the per-unit list', () => {
    const env = makeEnv();
    try {
      addUnit(env, 'q1', { i: 0, tail: call('q1', 0, 'q1-a', 'text') });
      const probeFile = runProbe(env);
      const adopted = monitorJson(env, ['--probe', probeFile], false);
      expect(adopted.period).toEqual({ from: '2026-11-08T00:00:00Z', to: UNTIL });
      expect(adopted.units).toBe(1);
      const mismatch = runMonitor(env, ['--probe', probeFile, '--to', '2026-11-16T00:00:00Z', '--days', '7'], false);
      expect(mismatch.status).toBe(2);
      expect(mismatch.stderr).toMatch(/differs from the probe/);
      const noList = join(env.dir, 'no-list.json');
      writeFileSync(noList, JSON.stringify({ period: { from: '2026-11-08T00:00:00Z', to: UNTIL }, results: [] }));
      const refused = runMonitor(env, ['--probe', noList], false);
      expect(refused.status).toBe(2);
      expect(refused.stderr).toMatch(/per-unit list/);
    } finally {
      cleanup(env);
    }
  });

  it('missing compaction journal and bad options exit 2', () => {
    const env = makeEnv();
    try {
      const missing = spawnSync('python3', ['-I', MONITOR, '--projects', env.projects, '--compact', join(env.dir, 'absent.jsonl')], { encoding: 'utf8' });
      expect(missing.status).toBe(2);
      expect(missing.stderr).toMatch(/compaction log not found/);
      flushLog(env);
      const negative = spawnSync('python3', ['-I', MONITOR, '--projects', env.projects, '--compact', env.compactLog, '--days', '-1'], { encoding: 'utf8' });
      expect(negative.status).toBe(2);
    } finally {
      cleanup(env);
    }
  });

  it('an explicit --transcript path or a --projects directory that cannot be read stops the run with exit 2; a searched file is not an explicit path', () => {
    const env = makeEnv();
    try {
      const good = addUnit(env, 'q1', { i: 0, tail: call('q1', 0, 'q1-a', 'text'), log: 'jev' });
      const absent = join(env.dir, 'absent-transcript.jsonl');
      const directory = join(env.projects, '-demo');
      for (const [label, bad] of [['missing', absent], ['directory', directory]] as const) {
        for (const order of [[bad], [good, bad], [bad, good]]) {
          const extra = order.flatMap((path) => ['--transcript', path]);
          const stopped = runMonitor(env, extra);
          expect(stopped.status, `${label} ${order.length}: ${stopped.stderr}`).toBe(2);
          expect(stopped.stdout, label).toBe('');
          expect(stopped.stderr, label).toContain(`--transcript`);
          expect(stopped.stderr, label).toContain(bad);
          expect(stopped.stderr, label).not.toMatch(/skipping|Traceback/);
        }
      }
      const only = runMonitor(env, ['--transcript', good, '--json']);
      expect(only.status, only.stderr).toBe(0);
      expect(JSON.parse(only.stdout).units).toBe(1);
      const searched = runMonitor(env, ['--json']);
      expect(searched.status, searched.stderr).toBe(0);
      expect(JSON.parse(searched.stdout).units).toBe(1);
      const mistyped = join(env.dir, 'projcts');
      for (const bad of [mistyped, good]) {
        flushLog(env);
        const stopped = spawnSync('python3', ['-I', MONITOR, '--projects', bad, '--compact', env.compactLog, '--to', UNTIL, '--days', '7'], { encoding: 'utf8' });
        expect(stopped.status, stopped.stderr).toBe(2);
        expect(stopped.stdout).toBe('');
        expect(stopped.stderr).toContain('--projects');
        expect(stopped.stderr).toContain(bad);
      }
    } finally {
      cleanup(env);
    }
  });

  it('unreadable lines are counted per input and a journal without a JSON object warns', () => {
    const env = makeEnv();
    try {
      const path = addUnit(env, 'q1', { i: 0, log: 'jev', tail: call('q1', 0, 'q1-a', 'text') });
      writeFileSync(path, readFileSync(path, 'utf8') + 'not json\n[1, 2]\n');
      const args = ['-I', MONITOR, '--projects', env.projects, '--compact', env.compactLog, '--to', UNTIL, '--days', '7'];
      // 100 lines and none is a JSON object: exit 0 as before, but the counts and a warning say so.
      writeFileSync(env.compactLog, 'garbage line\n'.repeat(100));
      const broken = spawnSync('python3', [...args, '--compact', env.compactLog, '--json'], { encoding: 'utf8' });
      expect(broken.status, broken.stderr).toBe(0);
      expect(broken.stderr).toMatch(/none of the 100 lines of the compaction log is a JSON object/);
      const report = JSON.parse(broken.stdout);
      expect(report.input.journal).toEqual({ rows: 0, bad_lines: 100 });
      expect(report.input.transcripts.bad_lines).toBe(2);
      expect(report.input.transcripts.rows).toBeGreaterThan(0);
      expect(Object.keys(report.signals.empty_series)).toEqual(['host/main']);
      const text = spawnSync('python3', [...args], { encoding: 'utf8' });
      expect(text.stdout).toMatch(/input: journal rows 0, bad lines 100; transcripts rows \d+, bad lines 2/);
      // A journal with some readable rows: counted, no warning.
      writeFileSync(env.compactLog, [...env.compactRows.map((row) => JSON.stringify(row)), 'oops', '[]'].join('\n') + '\n');
      const mixed = spawnSync('python3', [...args, '--json'], { encoding: 'utf8' });
      expect(mixed.status, mixed.stderr).toBe(0);
      expect(mixed.stderr).toBe('');
      expect(JSON.parse(mixed.stdout).input.journal).toEqual({ rows: 1, bad_lines: 2 });
      expect(Object.keys(JSON.parse(mixed.stdout).signals.empty_series)).toEqual(['jev/main']);
    } finally {
      cleanup(env);
    }
  });

  it('read-only: inputs stay byte-identical and no bytecode directory appears', () => {
    const env = makeEnv();
    try {
      const path = addUnit(env, 'r1', { i: 0, log: 'jev', tail: call('r1', 0, 'r1-a', 'text') });
      flushLog(env);
      const before = [readFileSync(path, 'utf8'), readFileSync(env.compactLog, 'utf8')];
      // Compare the tool directory before and after the run: another process may have left a bytecode
      // directory there earlier, so only a change made by this run counts.
      const toolDirBefore = readdirSync(dirname(MONITOR)).sort();
      monitorJson(env);
      expect([readFileSync(path, 'utf8'), readFileSync(env.compactLog, 'utf8')]).toEqual(before);
      expect(readdirSync(dirname(MONITOR)).sort()).toEqual(toolDirBefore);
    } finally {
      cleanup(env);
    }
  });
});
