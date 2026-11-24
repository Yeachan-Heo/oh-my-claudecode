import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HANDOFF_EVENTS,
  KINDS,
  REASON_CODES,
  RESULTS,
  STATES,
  readJournal,
  summarize,
  validateRow,
} from '../../tools/diagnostics/denial_log_summary.mjs';

// Tests for tools/diagnostics/denial_log_summary.mjs on synthetic journals (temp directory only, no network).
const SCRIPT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'tools', 'diagnostics', 'denial_log_summary.mjs');

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'denial-log-summary-')));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
const hex = (n: number) => n.toString(16).padStart(16, '0');
const nextId = () => hex(++counter);

type Row = Record<string, unknown>;

function decision(over: Row = {}): Row {
  const ts_ms = (over.ts_ms as number | undefined) ?? 1731600000000;
  return {
    ts: new Date(ts_ms).toISOString(), ts_ms, point: 'denial', id: nextId(), kind: 'denial',
    session_id: 'sA', agent_id: null, guard: 'g1', key: 'aaaaaaaaaaaaaaaa', n: 3, sessionCount: 3, k: 3, maxSession: 20,
    degree: 1, result: 'denied', action: 'escalation-1', reason_code: 'guard_denial', effectiveness: null, state: 'ok',
    tool_name: 'Bash', tool_use_id: null,
    ...over,
  };
}

function outcome(ref: string, over: Row = {}): Row {
  const ts_ms = (over.ts_ms as number | undefined) ?? 1731600000500;
  return {
    ts: new Date(ts_ms).toISOString(), ts_ms, point: 'denial', id: nextId(), kind: 'outcome', ref,
    session_id: 'sA', agent_id: null, guard: 'g1', key: 'aaaaaaaaaaaaaaaa', result: 'denied', effectiveness: null,
    ...over,
  };
}

function handoff(over: Row = {}): Row {
  const ts_ms = (over.ts_ms as number | undefined) ?? 1731600000000;
  return {
    ts: new Date(ts_ms).toISOString(), ts_ms, point: 'denial', id: nextId(), kind: 'handoff',
    session_id: 'sA', agent_id: null, guard: 'handoff', action: 'warning', result: 'passed', tool_name: 'Bash', tool_use_id: null, bytes: null,
    ...over,
  };
}

function writeJournal(name: string, rows: Array<Row | string>): string {
  const file = join(dir, name);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
  return file;
}

// The state root the resolver returns for a working directory, asked in a child process (the tool is not involved).
function stateRootFor(cwd: string, env: Record<string, string> = {}): string {
  const stateRootModule = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'scripts', 'lib', 'state-root.mjs');
  const code = `import(${JSON.stringify(stateRootModule)}).then(async (m) => console.log(await m.resolveOmcStateRoot(process.cwd())))`;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', cwd, env: { ...process.env, HOME: dir, OMC_STATE_DIR: '', CLAUDE_PLUGIN_ROOT: '', ...env } });
  return r.stdout.trim();
}

function run(args: string[], env: Record<string, string> = {}, cwd: string = dir) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd, env: { ...process.env, HOME: dir, OMC_JEV_LOG_DIR: '', OMC_STATE_DIR: '', CLAUDE_PLUGIN_ROOT: '', ...env } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('denial_log_summary.mjs summary', () => {
  it('counts unique keys, flags one key with different facts and counts a duplicate from two journals once', () => {
    const d1 = decision({ session_id: 'sA', guard: 'g1', key: 'aaaaaaaaaaaaaaaa', n: 3, sessionCount: 3, k: 3, maxSession: 20, degree: 1, result: 'denied', action: 'escalation-1' });
    const o1 = outcome(d1.id as string, { session_id: 'sA', result: 'denied' });
    const d2 = decision({ session_id: 'sA', guard: 'g1', key: 'aaaaaaaaaaaaaaaa', n: 5, sessionCount: 5, k: 3, maxSession: 20, degree: 2, result: 'denied', action: 'escalation-2' });
    const d3 = decision({ session_id: 'sB', guard: 'g1', key: 'bbbbbbbbbbbbbbbb', n: 1, sessionCount: 1, k: 3, maxSession: 4, degree: 0, result: 'denied', action: 'deny-storm' });
    // the same key released: one key with two different facts (denied, passed)
    const release = decision({ kind: 'release', session_id: 'sB', guard: 'g1', key: 'aaaaaaaaaaaaaaaa', n: null, sessionCount: 3, degree: 0, result: 'passed', action: 'release' });
    const written = [d1, o1, d2, d3, release];
    expect(written).toHaveLength(5);
    expect(written.every((row) => validateRow(row).ok)).toBe(true);
    const file = writeJournal('dup/denials.jsonl', written);
    const result = summarize([file, file]);
    expect(result.rows).toBe(5);
    expect(result.duplicates).toBe(5);
    expect(result.unparseable).toBe(0);
    expect(result.outOfSchema).toBe(0);
    const denial = result.kinds.find((g: { group: string }) => g.group === 'denial');
    expect(denial.count).toBe(3);
    expect(denial.keys).toBe(2);
    expect(result.differentFacts).toEqual(['aaaaaaaaaaaaaaaa']);
    const subjectA = result.subjects.find((p: { group: string }) => p.group === 'session sA');
    expect(subjectA.count).toBe(3);
  });

  it('computes p50 and p95 of the decision-to-outcome time by ref', () => {
    const rows: Row[] = [];
    for (let i = 0; i < 4; i++) {
      const d = decision({ key: 'cccccccccccccccc', ts_ms: 1731600000000 + i * 1000 });
      rows.push(d, outcome(d.id as string, { ts_ms: 1731600000000 + i * 1000 + (i + 1) * 100 }));
    }
    const result = summarize([writeJournal('p50/denials.jsonl', rows)]);
    const denial = result.kinds.find((g: { group: string }) => g.group === 'denial');
    expect(denial.count).toBe(4);
    expect(denial.keys).toBe(1);
    expect(denial.p50_ms).toBe(200);
    expect(denial.p95_ms).toBe(400);
    const outcomeGroup = result.kinds.find((g: { group: string }) => g.group === 'outcome');
    expect(outcomeGroup.p50_ms).toBeNull();
  });

  it('ignores an outcome that precedes its decision or has no matching decision', () => {
    const d = decision({ key: 'dddddddddddddddd' });
    const orphan = outcome(hex(9999));
    const early = outcome(d.id as string, { ts_ms: 1731599999000 });
    const result = summarize([writeJournal('orphan/denials.jsonl', [orphan, early, d])]);
    const denial = result.kinds.find((g: { group: string }) => g.group === 'denial');
    expect(denial.p50_ms).toBeNull();
  });

  it('matches outcomes to decisions across multiple files in any order (outcome-first file read before decision-only file)', () => {
    const d = decision({ key: 'cccccccccccccccc' });
    const o = outcome(d.id as string, { ts_ms: 1731600000500 });
    // Write outcome to file A (read first), decision to file B (read second, like a rotated log)
    const fileA = writeJournal('order/denials-20261114-100000.jsonl', [o]);
    const fileB = writeJournal('order/denials-20261114-093000.jsonl', [d]);
    const result = summarize([fileA, fileB]); // Read newest-first (A before B)
    const denial = result.kinds.find((g: { group: string }) => g.group === 'denial');
    expect(denial.p50_ms).toBe(500); // Outcome should be matched despite being read first
  });

  it('skips unparseable rows and counts them; rows without an id are all kept', () => {
    const file = writeJournal('trunc/denials-20261114-101500.jsonl', [
      decision({ key: 'eeeeeeeeeeeeeeee' }),
      '{"ts":"2026-11-14T10:15:00.000Z","point":"den',
      '[1,2,3]',
      JSON.stringify({ kind: 'state' }),
      JSON.stringify({ kind: 'state' }),
    ]);
    const parsed = readJournal([file]);
    expect(parsed.unparseable).toBe(2);
    expect(parsed.duplicates).toBe(0);
    expect(parsed.rows).toHaveLength(3);
    const result = summarize([file]);
    expect(result.outOfSchema).toBe(2);
  });

  it('does not fail on a missing file', () => {
    const result = summarize([join(dir, 'no-such-file.jsonl')]);
    expect(result.rows).toBe(0);
  });

  it('separates a subagent from its session and names a row without a session', () => {
    const rows = [decision({ session_id: 'sC', agent_id: 'ag1', key: 'ffffffffffffffff' }), decision({ session_id: 'sC', agent_id: null, key: 'ffffffffffffffff' }), decision({ session_id: null, key: '1111111111111111' })];
    const result = summarize([writeJournal('agent/denials.jsonl', rows)]);
    const names = result.subjects.map((s: { group: string }) => s.group).sort();
    expect(names).toEqual(['no-subject', 'session sC', 'session sC/ag1']);
  });

  it('counts two subagents of one session in the same millisecond as separate handoff events', () => {
    const rows = [
      handoff({ agent_id: 'agent-A', action: 'handoff-subagent', tool_use_id: null, ts_ms: 1731600000000 }),
      handoff({ agent_id: 'agent-B', action: 'handoff-subagent', tool_use_id: null, ts_ms: 1731600000000 }),
    ];
    const result = summarize([writeJournal('handoff/denials.jsonl', rows)]);
    expect(result.kinds.find((g: { group: string }) => g.group === 'handoff').count).toBe(2);
    expect(result.outOfSchema).toBe(0);
  });

  it('summarizes release and state rows by kind', () => {
    const rows = [
      decision({ kind: 'release', key: '7777777777777777', result: 'passed', degree: 0, action: 'release' }),
      decision({ kind: 'state', key: '7777777777777777', n: null, sessionCount: null, degree: 0, action: 'state-lock-unavailable', state: 'lock-unavailable' }),
    ];
    const result = summarize([writeJournal('release/denials.jsonl', rows)]);
    const kinds = result.kinds.map((g: { group: string }) => g.group).sort();
    expect(kinds).toEqual(['release', 'state']);
    expect(result.outOfSchema).toBe(0);
  });
});

describe('denial_log_summary.mjs schema validator', () => {
  it('accepts the rows the counter writes', () => {
    const d = decision();
    expect(validateRow(d)).toEqual({ ok: true, errors: [] });
    expect(validateRow(decision({ kind: 'state', n: null, sessionCount: null, degree: 0, action: 'state-lock-unavailable', state: 'lock-unavailable' })).ok).toBe(true);
    expect(validateRow(decision({ kind: 'release', result: 'passed', action: 'release' })).ok).toBe(true);
    expect(validateRow(outcome(d.id as string)).ok).toBe(true);
    expect(validateRow(outcome(d.id as string, { effectiveness: null })).ok).toBe(true);
    expect(validateRow({ ...d, truncated: true }).ok).toBe(true);
  });

  it('rejects rows without required fields and values outside the vocabularies', () => {
    expect(validateRow(null).ok).toBe(false);
    expect(validateRow([]).errors).toEqual(['row-not-object']);
    expect(validateRow({}).errors).toContain('id');
    const d = decision();
    expect(validateRow({ ...d, id: 'bad-id' }).errors).toContain('id');
    expect(validateRow({ ...d, kind: 'other-kind' }).errors).toContain('kind');
    expect(validateRow({ ...d, point: 'journal' }).errors).toContain('point');
    expect(validateRow({ ...d, guard: undefined }).errors).toContain('guard');
    expect(validateRow({ ...d, key: 'cc' }).errors).toContain('key');
    expect(validateRow({ ...d, result: 'bad-result' }).errors).toContain('result');
    expect(validateRow({ ...d, degree: 3 }).errors).toContain('degree');
    expect(validateRow({ ...d, action: '' }).errors).toContain('action');
    expect(validateRow({ ...d, reason_code: 'unknown' }).errors).toContain('reason_code');
    expect(validateRow({ ...d, effectiveness: 'returned' }).errors).toContain('effectiveness');
    expect(validateRow({ ...d, state: 'unknown-state' }).errors).toContain('state');
    expect(validateRow({ ...d, k: 0 }).errors).toContain('k');
    expect(validateRow({ ...d, maxSession: 0 }).errors).toContain('maxSession');
    expect(validateRow({ ...d, tool_name: 5 }).errors).toContain('tool_name');
    expect(validateRow({ ...d, truncated: false }).errors).toContain('truncated');
    expect(validateRow({ ...d, session_id: undefined }).errors).toContain('session_id');
    expect(validateRow({ ...d, agent_id: undefined }).errors).toContain('agent_id');
    const o = outcome(d.id as string);
    expect(validateRow({ ...o, ref: undefined }).errors).toContain('ref');
    expect(validateRow({ ...o, result: 'bad' }).errors).toContain('result');
    expect(validateRow({ ...o, effectiveness: 'returned' }).errors).toContain('effectiveness-outcome');
  });

  it('accepts the rows exactly as the denial counter and the handoff writer emit them', () => {
    const ts = '2026-11-14T10:00:00.000Z';
    const common = { ts, ts_ms: Date.parse(ts), point: 'denial' };
    const denial = { ...common, id: 'a1b2c3d4e5f60718', kind: 'denial', session_id: 's1', agent_id: null, guard: 'ultragoal-goal', key: '0123456789abcdef', n: 3, sessionCount: 3, k: 3, maxSession: 20, degree: 1, result: 'denied', action: 'escalation-1', reason_code: 'guard_denial', effectiveness: null, state: 'ok', tool_name: 'Bash', tool_use_id: 'toolu_1' };
    const brokenState = { ...denial, id: 'a1b2c3d4e5f60719', kind: 'state', n: null, sessionCount: null, degree: 2, action: 'state-broken', state: 'broken', tool_name: null, tool_use_id: null };
    const release = { ...denial, id: 'a1b2c3d4e5f6071a', kind: 'release', degree: 0, result: 'passed', action: 'release' };
    const outcomeRow = { ...common, id: 'a1b2c3d4e5f6071b', kind: 'outcome', ref: denial.id, session_id: 's1', agent_id: null, guard: 'ultragoal-goal', key: denial.key, result: 'denied', effectiveness: null };
    const handoffRow = { ...common, id: 'a1b2c3d4e5f6071c', kind: 'handoff', guard: 'handoff', action: 'warning', result: 'passed', session_id: 's1', agent_id: null, tool_name: 'Read', tool_use_id: null, bytes: 20971521 };
    for (const row of [denial, brokenState, release, outcomeRow, handoffRow, { ...denial, truncated: true }]) {
      expect(validateRow(row), JSON.stringify(row)).toEqual({ ok: true, errors: [] });
    }
  });

  it('checks the handoff rows: the event is carried by the action field', () => {
    const h = handoff();
    expect(validateRow(h)).toEqual({ ok: true, errors: [] });
    for (const event of HANDOFF_EVENTS) {
      expect(validateRow(handoff({ action: event })).ok, event).toBe(true);
    }
    expect(validateRow({ ...h, action: 'unknown-event' }).errors).toContain('action');
    expect(validateRow({ ...h, guard: 'other' }).errors).toContain('guard');
    expect(validateRow({ ...h, result: 'bad-result' }).errors).toContain('result');
    expect(validateRow({ ...h, bytes: undefined }).errors).toContain('bytes');
    expect(validateRow({ ...h, bytes: -1 }).errors).toContain('bytes');
    expect(validateRow({ ...h, bytes: 1048576 }).ok).toBe(true);
    expect(validateRow({ ...h, agent_id: undefined }).errors).toContain('agent_id');
    expect(validateRow({ ...h, tool_name: 5 }).errors).toContain('tool_name');
    expect(validateRow({ ...h, result: 'denied', action: 'handoff-refused' }).ok).toBe(true);
  });

  it('rejects the kinds and values that the writer does not emit', () => {
    expect(validateRow(decision({ kind: 'end' })).errors).toContain('kind');
    expect(validateRow(decision({ kind: 'nudge' })).errors).toContain('kind');
    expect(validateRow(decision({ result: 'blocked' })).errors).toContain('result');
    expect(validateRow(decision({ reason_code: 'missing_fact' })).errors).toContain('reason_code');
  });
});

describe('denial_log_summary.mjs validator sets', () => {
  // The validator keeps its own copy of the closed vocabularies of the journal rows on purpose (the tool runs from a
  // plain checkout and does not import the hook library). The denial counter that writes the journal is not part of
  // this change, so the sets are pinned here: they mirror the denial counter of the session guards change
  // (scripts/lib/jev-denial-counter.mjs and the handoff rows of scripts/lib/jev-handoff.mjs). A vocabulary change there
  // has to update the validator and this list together.
  const sorted = (values: readonly string[]) => [...values].sort();

  it('pins the row kinds, results, handoff events, reason codes and states', () => {
    expect(sorted(KINDS)).toEqual(sorted(['denial', 'release', 'state', 'outcome', 'handoff']));
    expect(sorted(RESULTS)).toEqual(sorted(['denied', 'passed']));
    expect(sorted(HANDOFF_EVENTS)).toEqual(sorted(['warning', 'handoff-allowed', 'handoff-subagent', 'handoff-refused', 'handed-over-refused']));
    expect(sorted(REASON_CODES)).toEqual(['guard_denial']);
    expect(sorted(STATES)).toEqual(sorted(['ok', 'broken', 'nan', 'lock-unavailable']));
  });

  it('accepts every pinned value and rejects a value outside the set', () => {
    for (const result of RESULTS) expect(validateRow(decision({ result })).ok).toBe(true);
    for (const state of STATES) expect(validateRow(decision({ state })).ok).toBe(true);
    for (const code of REASON_CODES) expect(validateRow(decision({ reason_code: code })).ok).toBe(true);
    expect(validateRow(decision({ reason_code: 'not-in-the-set' })).ok).toBe(false);
    expect(validateRow(decision({ result: 'not-in-the-set' })).ok).toBe(false);
    expect(validateRow(decision({ state: 'not-in-the-set' })).ok).toBe(false);
  });
});

describe('denial_log_summary.mjs command line', () => {
  it('prints a text summary for a file argument and exits 0', () => {
    const d = decision({ key: '2222222222222222' });
    const file = writeJournal('cli/file/denials.jsonl', [d, outcome(d.id as string)]);
    const r = run(['--file', file]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('files: 1, rows: 2');
    expect(r.stdout).toContain('== by event kind (kind)');
    expect(r.stdout).toContain('group | rows | degrees | results | keys | p50_ms | p95_ms');
    expect(r.stdout).toContain('denial | 1 | d1=1 | denied=1 | 1 | 500 | 500');
    expect(r.stdout).toContain('== by subject (session)');
  });

  it('accepts a positional path and --json output', () => {
    const file = writeJournal('cli/json/denials.jsonl', [decision({ key: '3333333333333333' })]);
    const r = run([file, '--json']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.rows).toBe(1);
    expect(parsed.kinds[0].group).toBe('denial');
  });

  it('reads a positional file in addition to the default directory', () => {
    writeJournal('cli/pos/default/denials.jsonl', [decision({ key: '8888888888888888' })]);
    const file = writeJournal('cli/pos/extra.jsonl', [decision({ key: '9999999999999999' })]);
    const r = run([file, '--json'], { OMC_JEV_LOG_DIR: join(dir, 'cli/pos/default') });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).rows).toBe(2);
    const only = run(['--file', file, '--json'], { OMC_JEV_LOG_DIR: join(dir, 'cli/pos/default') });
    expect(JSON.parse(only.stdout).rows).toBe(1);
  });

  it('prints the different-facts line for a key with two facts', () => {
    const file = writeJournal('cli/facts/denials.jsonl', [
      decision({ key: '4444444444444444', result: 'denied' }),
      decision({ key: '4444444444444444', result: 'passed', kind: 'release', action: 'release' }),
    ]);
    const r = run(['--file', file]);
    expect(r.stdout).toContain('DIFFERENT-FACTS key=4444444444444444');
  });

  it('reads the active file and the rotated parts of a directory, and skips other files', () => {
    const base = 'cli/dir';
    writeJournal(`${base}/denials.jsonl`, [decision({ key: '5555555555555555' })]);
    writeJournal(`${base}/denials-20261114-101500.jsonl`, [decision({ key: '5555555555555555' })]);
    writeJournal(`${base}/denials-20261114-101600-4242.jsonl`, [decision({ key: '5555555555555555' })]);
    writeJournal(`${base}/other.jsonl`, [decision({ key: '5555555555555555' })]);
    const r = run(['--dir', join(dir, base), '--json']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).rows).toBe(3);
  });

  it('defaults to OMC_JEV_LOG_DIR', () => {
    writeJournal('cli/env/denials.jsonl', [decision({ key: '6666666666666666' })]);
    const r = run([], { OMC_JEV_LOG_DIR: join(dir, 'cli/env') });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('files: 1, rows: 1');
  });

  it('without OMC_JEV_LOG_DIR defaults to state/jev under the state root of the current directory', () => {
    mkdirSync(join(dir, 'cli/cwd/proj/.git'), { recursive: true }); // marks the project root for the state root resolver
    writeJournal('cli/cwd/proj/.omc/state/jev/denials.jsonl', [decision({ key: 'c1c1c1c1c1c1c1c1' })]);
    const r = run([], {}, join(dir, 'cli/cwd/proj'));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('files: 1, rows: 1');
  });

  it('with OMC_STATE_DIR set, defaults to the state/jev directory the state root resolver returns', () => {
    const cwd = join(dir, 'cli/statedir/proj');
    mkdirSync(join(cwd, '.git'), { recursive: true });
    writeJournal('cli/statedir/proj/.omc/state/jev/denials.jsonl', [decision({ key: 'f1f1f1f1f1f1f1f1' }), decision({ key: 'f2f2f2f2f2f2f2f2' })]);
    const env = { OMC_STATE_DIR: join(dir, 'cli/statedir/custom') };
    const root = stateRootFor(cwd, env);
    expect(root.startsWith(env.OMC_STATE_DIR)).toBe(true);
    writeJournal(relative(dir, join(root, 'state', 'jev', 'denials.jsonl')), [decision({ key: 'f3f3f3f3f3f3f3f3' })]);
    const r = run([], env, cwd);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('files: 1, rows: 1');
  });

  it('exits 2 and asks for --dir or OMC_JEV_LOG_DIR when the state root cannot be resolved', () => {
    const pluginRoot = join(dir, 'cli/badplugin');
    mkdirSync(join(pluginRoot, 'dist', 'lib'), { recursive: true });
    writeFileSync(join(pluginRoot, 'dist', 'lib', 'worktree-paths.js'), "throw new Error('boom');\n");
    const cwd = join(dir, 'cli/badplugin/proj');
    mkdirSync(join(cwd, '.omc/state/jev'), { recursive: true });
    writeJournal('cli/badplugin/proj/.omc/state/jev/denials.jsonl', [decision({ key: '9a9a9a9a9a9a9a9a' })]);
    const r = run([], { CLAUDE_PLUGIN_ROOT: pluginRoot }, cwd);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('cannot resolve the state root');
    expect(r.stderr).toContain('--dir');
    expect(r.stderr).toContain('OMC_JEV_LOG_DIR');
    expect(r.stdout).not.toContain('files:');
  });

  it('OMC_JEV_LOG_DIR wins over .omc/state/jev under the current directory', () => {
    writeJournal('cli/cwdwin/proj/.omc/state/jev/denials.jsonl', [decision({ key: 'd1d1d1d1d1d1d1d1' })]);
    writeJournal('cli/cwdwin/env/denials.jsonl', [decision({ key: 'd2d2d2d2d2d2d2d2' }), decision({ key: 'd3d3d3d3d3d3d3d3' })]);
    const r = run([], { OMC_JEV_LOG_DIR: join(dir, 'cli/cwdwin/env') }, join(dir, 'cli/cwdwin/proj'));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('files: 1, rows: 2');
  });

  it('does not read ~/.omc/state/jev from inside a project that has no journal', () => {
    writeJournal('.omc/state/jev/denials.jsonl', [decision({ key: 'e1e1e1e1e1e1e1e1' })]);
    mkdirSync(join(dir, 'cli/nohome/.git'), { recursive: true });
    const r = run([], {}, join(dir, 'cli/nohome'));
    expect(r.status).toBe(2);
  });

  it('outside a repository the default is the state root fallback of the resolver (~/.omc)', () => {
    writeJournal('.omc/state/jev/denials.jsonl', [decision({ key: 'e2e2e2e2e2e2e2e2' })]);
    mkdirSync(join(dir, 'cli/nogit'), { recursive: true });
    const r = run([], {}, join(dir, 'cli/nogit'));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('files: 1, rows: 1');
  });

  it('warns on stderr for a file given with --file that does not exist, without changing the summary or the exit code', () => {
    const existing = writeJournal('cli/warn/denials.jsonl', [decision({ key: 'abababababababab' })]);
    const missing = join(dir, 'cli/warn/typo.jsonl');
    const r = run(['--file', missing, '--file', existing]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain(`warning: file not found: ${missing}`);
    expect(r.stdout).toContain('files: 2, rows: 1');
    const quiet = run(['--file', existing]);
    expect(quiet.stderr).toBe('');
    const onlyMissing = run(['--file', missing]);
    expect(onlyMissing.status).toBe(0);
    expect(onlyMissing.stdout).toContain('files: 1, rows: 0');
    expect(onlyMissing.stderr).toContain('file not found');
  });

  it('exits 2 when no journal file is found', () => {
    mkdirSync(join(dir, 'cli/empty'), { recursive: true });
    const r = run(['--dir', join(dir, 'cli/empty')]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('no denials.jsonl journal files found');
  });

  it('prints usage for --help', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('usage: node denial_log_summary.mjs');
    expect(r.stdout).toContain('OMC_STATE_DIR');
  });
});
