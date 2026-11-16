import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EFFECTIVENESS,
  END_TYPES,
  HANDOFF_EVENTS,
  KINDS,
  REASON_CODES,
  RESULTS,
  readJournal,
  summarize,
  validateRow,
} from '../../tools/diagnostics/denial_log_summary.mjs';

// Tests for tools/diagnostics/denial_log_summary.mjs on synthetic journals (temp directory only, no network).
const SCRIPT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'tools', 'diagnostics', 'denial_log_summary.mjs');

const dir = mkdtempSync(join(tmpdir(), 'denial-log-summary-'));
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
    session_id: 'sA', agent_id: null, event: 'warning-20mib', result: 'passed', tool_name: 'Bash', tool_use_id: null, bytes: null,
    ...over,
  };
}

function writeJournal(name: string, rows: Array<Row | string>): string {
  const file = join(dir, name);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
  return file;
}

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, HOME: dir, OMC_JEV_LOG_DIR: '', ...env } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('denial_log_summary.mjs summary', () => {
  it('counts unique keys, flags one key with different facts and counts a duplicate from two journals once', () => {
    const d1 = decision({ session_id: 'sA', guard: 'g1', key: 'aaaaaaaaaaaaaaaa', n: 3, sessionCount: 3, k: 3, maxSession: 20, degree: 1, result: 'denied', action: 'escalation-1' });
    const o1 = outcome(d1.id as string, { session_id: 'sA', result: 'denied' });
    const d2 = decision({ session_id: 'sA', guard: 'g1', key: 'aaaaaaaaaaaaaaaa', n: 4, sessionCount: 4, k: 3, maxSession: 20, degree: 1, result: 'blocked', action: 'blocked' });
    const d3 = decision({ session_id: 'sB', guard: 'g1', key: 'bbbbbbbbbbbbbbbb', n: 1, sessionCount: 1, k: 3, maxSession: 4, degree: 0, result: 'denied', action: 'deny-storm' });
    const end = { ts: new Date(1731600000000).toISOString(), ts_ms: 1731600000000, point: 'denial', id: nextId(), kind: 'end', session_id: 'sB', agent_id: null, type: 'awaiting-human' };
    const written = [d1, o1, d2, d3, end];
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

  it('separates a subagent from its session and names a task subject', () => {
    const rows = [decision({ session_id: 'sC', agent_id: 'ag1', key: 'ffffffffffffffff' }), decision({ session_id: 'sC', agent_id: null, key: 'ffffffffffffffff' }), decision({ session_id: null, key: '1111111111111111' }), decision({ session_id: null, task: 'job-7', key: '1111111111111111' })];
    const result = summarize([writeJournal('agent/denials.jsonl', rows)]);
    const names = result.subjects.map((s: { group: string }) => s.group).sort();
    expect(names).toEqual(['no-subject', 'session sC', 'session sC/ag1', 'task job-7']);
  });

  it('counts two subagents of one session in the same millisecond as separate handoff events', () => {
    const rows = [
      handoff({ agent_id: 'agent-A', event: 'handoff-subagent', tool_use_id: null, ts_ms: 1731600000000 }),
      handoff({ agent_id: 'agent-B', event: 'handoff-subagent', tool_use_id: null, ts_ms: 1731600000000 }),
    ];
    const result = summarize([writeJournal('handoff/denials.jsonl', rows)]);
    expect(result.kinds.find((g: { group: string }) => g.group === 'handoff').count).toBe(2);
    expect(result.outOfSchema).toBe(0);
  });

  it('summarizes nudge and end rows by kind', () => {
    const rows = [
      decision({ kind: 'nudge', guard: 'error-loop', key: '7777777777777777', result: 'passed', reason_code: 'error_loop', action: 'nudge' }),
      { ts: new Date(1731600000000).toISOString(), ts_ms: 1731600000000, point: 'denial', id: nextId(), kind: 'end', session_id: 'sA', agent_id: null, type: 'awaiting-human' },
    ];
    const result = summarize([writeJournal('nudge/denials.jsonl', rows)]);
    const kinds = result.kinds.map((g: { group: string }) => g.group).sort();
    expect(kinds).toEqual(['end', 'nudge']);
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
    expect(validateRow(outcome(d.id as string, { effectiveness: 'returned' })).ok).toBe(true);
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
    expect(validateRow({ ...d, effectiveness: 'maybe' }).errors).toContain('effectiveness');
    expect(validateRow({ ...d, k: 0 }).errors).toContain('k');
    expect(validateRow({ ...d, maxSession: 0 }).errors).toContain('maxSession');
    expect(validateRow({ ...d, tool_name: 5 }).errors).toContain('tool_name');
    expect(validateRow({ ...d, truncated: false }).errors).toContain('truncated');
    expect(validateRow({ ...d, session_id: undefined }).errors).toContain('session_id');
    expect(validateRow({ ...d, agent_id: undefined }).errors).toContain('agent_id');
    const o = outcome(d.id as string);
    expect(validateRow({ ...o, ref: undefined }).errors).toContain('ref');
    expect(validateRow({ ...o, result: 'bad' }).errors).toContain('result');
    expect(validateRow({ ...o, effectiveness: 'maybe' }).errors).toContain('effectiveness-outcome');
  });

  it('checks the end and handoff rows and the task field', () => {
    const end = { ts: new Date().toISOString(), ts_ms: 2, point: 'denial', id: hex(70001), kind: 'end', session_id: 's', agent_id: null };
    expect(validateRow(end).errors).toContain('type');
    expect(validateRow({ ...end, type: 'step-budget' }).ok).toBe(true);
    expect(validateRow({ ...end, type: 'other' }).errors).toContain('type');
    const h = handoff();
    expect(validateRow(h)).toEqual({ ok: true, errors: [] });
    expect(validateRow({ ...h, event: 'unknown-event' }).errors).toContain('event');
    expect(validateRow({ ...h, result: 'bad-result' }).errors).toContain('result');
    expect(validateRow({ ...h, bytes: undefined }).errors).toContain('bytes');
    expect(validateRow({ ...h, bytes: -1 }).errors).toContain('bytes');
    expect(validateRow({ ...h, bytes: 1048576 }).ok).toBe(true);
    expect(validateRow({ ...h, agent_id: undefined }).errors).toContain('agent_id');
    expect(validateRow({ ...h, tool_name: 5 }).errors).toContain('tool_name');
    expect(validateRow({ ...h, result: 'blocked' }).ok).toBe(true);
    expect(validateRow({ ...decision(), task: 'job-1' }).ok).toBe(true);
    expect(validateRow({ ...decision(), task: 5 }).errors).toContain('task');
    expect(validateRow(decision({ kind: 'nudge', result: 'blocked', reason_code: 'error_loop' })).ok).toBe(true);
    expect(validateRow(decision({ reason_code: 'missing_fact' })).ok).toBe(true);
  });
});

describe('denial_log_summary.mjs validator sets', () => {
  // The validator keeps its own copy of the closed vocabularies of the journal rows on purpose (the tool runs from a
  // plain checkout and does not import the hook library). The counter that writes the journal is not part of this
  // change, so the sets are pinned here; they are meant to mirror the counter of the session guards change, and a
  // vocabulary change there has to update the validator and this list together. The handoff event names are the
  // validator's own: they have not been compared with the names the other change writes.
  const sorted = (values: readonly string[]) => [...values].sort();

  it('pins the row kinds, results, end types, handoff events, reason codes and effectiveness values', () => {
    expect(sorted(KINDS)).toEqual(sorted(['denial', 'release', 'state', 'end', 'outcome', 'handoff', 'nudge']));
    expect(sorted(RESULTS)).toEqual(sorted(['denied', 'passed', 'blocked']));
    expect(sorted(END_TYPES)).toEqual(sorted(['awaiting-human', 'stopped-with-reason', 'no-input', 'step-budget']));
    expect(sorted(HANDOFF_EVENTS)).toEqual(sorted(['warning-20mib', 'handoff-passed', 'handoff-denied', 'handoff-subagent', 'handed-off-denied']));
    expect(sorted(REASON_CODES)).toEqual(sorted([
      'missing_fact', 'fact_not_accepted', 'contradictory_declaration', 'consultation',
      'blocked_after_consultation', 'timeout', 'guard_denial', 'error_loop',
    ]));
    expect(sorted(EFFECTIVENESS)).toEqual(sorted(['returned', 'not-returned']));
  });

  it('accepts every pinned value and rejects a value outside the set', () => {
    for (const kind of ['end', 'outcome', 'handoff']) expect(KINDS).toContain(kind);
    for (const code of ['guard_denial', 'error_loop']) {
      expect(validateRow(decision({ reason_code: code })).ok).toBe(true);
    }
    for (const result of ['denied', 'passed', 'blocked']) {
      expect(validateRow(decision({ result })).ok).toBe(true);
    }
    expect(validateRow(decision({ reason_code: 'not-in-the-set' })).ok).toBe(false);
    expect(validateRow(decision({ result: 'not-in-the-set' })).ok).toBe(false);
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
  });
});
