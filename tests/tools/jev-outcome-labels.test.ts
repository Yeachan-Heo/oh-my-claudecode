import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Tests for tools/diagnostics/jev_outcome_labels.mjs on a synthetic fixture (temp directory only, no network).
// The script runs as a CLI (it exits at load), so every case spawns it with node.
const TOOLS = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'tools', 'diagnostics');
const SCRIPT = join(TOOLS, 'jev_outcome_labels.mjs');
const WILSON = join(TOOLS, 'wilson_threshold.mjs');
const D = '2026-11-14';
const TSV_HEADER = 'result\tconfidence\tmode\tpoint\tspec_version\tjev_model\tsession\tts';

/** One applied learner-extraction row. */
const learner = (ts: string, session: string, extra: Record<string, unknown> = {}, applied: Record<string, unknown> = {}) =>
  JSON.stringify({ ts: `${D}T${ts}:00.000Z`, point: 'learner-extraction', session_id: session, ...extra, applied });
/** One agent-type.jsonl row. */
const agentType = (ts: string, decision: string, session = 'sesA', agentId: string | null = null, mode = 'shadow') =>
  JSON.stringify({ ts: `${D}T${ts}:00.000Z`, point: 'agent-type', session_id: session, ...(agentId ? { agent_id: agentId } : {}), tool_name: 'Agent', subagent_type: 'general-purpose', mode, decision });
/** One transcript entry. */
const entry = (ts: string, type: string, content: unknown) => JSON.stringify({ type, timestamp: `${D}T${ts}:00.000Z`, sessionId: 'x', message: { content } });

let base: string;
let journal: string;
let transcripts: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'jev-outcome-labels-test-'));
  journal = join(base, 'jev');
  transcripts = join(base, 'transcripts');
  mkdirSync(journal, { recursive: true });
  mkdirSync(join(transcripts, 'proj'), { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** Builds the fixture: sessions with learner hints (executed by the Skill tool, executed by the /remember command, ignored with a full window, ignored with an incomplete window, undetermined without a transcript, ignored with remember in the fourth turn), a row only in a rotated file, agent-type denials, groups by spec_version and "no field", a timeline. */
function build(): void {
  // sesA: executed by the Skill tool remember in the rest of the current turn
  // sesB: executed by the /remember command in turn 1
  // sesC: ignored, 3 full turns without effect (spec_version abc123 group)
  // sesD: ignored, incomplete window (spec_version abc123 group)
  // sesE: undetermined, no session transcript
  // sesF: ignored, remember in turn 4 (outside the window)
  const applied = [
    learner('10:00', 'sesA', {}, { systemMessage: 'UNIQUE-HINT-TEXT-MARKER', noul: 0.92 }),
    learner('10:00', 'sesB', {}, { noul: 0.5 }),
    learner('10:00', 'sesC', { spec_version: 'abc123', jev_model: 'model-x' }, { noul: 0.75 }),
    learner('10:00', 'sesD', { spec_version: 'abc123', jev_model: 'model-x' }, { noul: 0.9 }),
    learner('10:00', 'sesE', {}, {}),
    learner('10:00', 'sesF', {}, { noul: 0.1 }),
  ];
  writeFileSync(join(journal, 'applied.jsonl'), applied.join('\n') + '\n');
  // a row only in a rotated file, session sesC, ts 09:00 (4 turns seen after ts, full window)
  writeFileSync(join(journal, 'applied-20261114-093000.jsonl'), learner('09:00', 'sesC', {}, { noul: 0.8 }) + '\n');
  const agentRows = [
    agentType('12:00', 'deny'), agentType('12:01', 'allow'),
    agentType('12:02', 'deny'), agentType('12:03', 'deny'),
    agentType('12:05', 'would-deny'),
    agentType('13:00', 'deny'),
  ];
  writeFileSync(join(journal, 'agent-type.jsonl'), agentRows.join('\n') + '\n');
  const transcriptFiles: Record<string, string[]> = {
    sesA: [entry('09:59', 'user', 'begin'), JSON.stringify({ type: 'assistant', timestamp: `${D}T10:00:30.000Z`, message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'oh-my-claudecode:remember' } }] } })],
    sesB: [entry('09:59', 'user', 'start'), entry('10:05', 'user', '<command-name>/oh-my-claudecode:remember</command-name> save this')],
    sesC: [entry('09:59', 'user', 'a'), entry('10:05', 'user', 'b'), entry('10:10', 'user', 'c'), entry('10:15', 'user', 'd')],
    sesD: [entry('09:59', 'user', 'a'), entry('10:05', 'user', 'b')],
    sesF: [entry('09:59', 'user', 'a'), entry('10:05', 'user', 'b'), entry('10:10', 'user', 'c'), entry('10:15', 'user', 'd'), entry('10:20', 'user', '<command-name>/remember</command-name> too late')],
  };
  for (const [session, entries] of Object.entries(transcriptFiles)) {
    writeFileSync(join(transcripts, 'proj', `${session}.jsonl`), entries.join('\n') + '\n');
  }
  // a row of another point (no label, timeline only)
  writeFileSync(join(journal, 'applied.jsonl'), applied.join('\n') + '\n' + JSON.stringify({ ts: `${D}T14:00:00.000Z`, point: 'loop-continuation', session_id: 'sesA', applied: { mode: 'loop', noul: 0.4 } }) + '\n');
}

/** Runs the script; returns exit code and output. */
function run(args: string[] = [], dirs = true) {
  const full = dirs ? ['--journal', journal, '--transcripts', transcripts, ...args] : args;
  const result = spawnSync(process.execPath, [SCRIPT, ...full], { encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** TSV rows as objects keyed by the header. */
function tsvRows(text: string): Record<string, string>[] {
  const lines = text.trimEnd().split('\n');
  const columns = lines[0].split('\t');
  return lines.slice(1).map((l) => Object.fromEntries(columns.map((k, i) => [k, l.split('\t')[i] ?? ''])));
}

describe('jev_outcome_labels', () => {
  it('learner-extraction labels by the 3-turn window and the TSV contract', () => {
    build();
    const tsvPath = join(base, 'result.tsv');
    const w = run(['--tsv', tsvPath]);
    expect(w.code, `exit 0, stderr: ${w.stderr}`).toBe(0);
    const text = readFileSync(tsvPath, 'utf8');
    expect(text.trimEnd().split('\n')[0]).toBe(TSV_HEADER);
    const rows = tsvRows(text);
    const learnerRows = rows.filter((x) => x.point === 'learner-extraction');
    expect(learnerRows.length).toBe(7);
    const resultBySession = Object.fromEntries(learnerRows.map((x) => [x.session, x.result]));
    expect(resultBySession.sesA).toBe('executed');
    expect(resultBySession.sesB).toBe('executed');
    expect(resultBySession.sesC).toBe('ignored');
    expect(resultBySession.sesD).toBe('ignored');
    expect(resultBySession.sesE).toBe('undetermined');
    expect(resultBySession.sesF).toBe('ignored');
    const bySession = Object.fromEntries(learnerRows.map((x) => [x.session, x]));
    expect(bySession.sesA.confidence).toBe('0.92');
    expect(bySession.sesE.confidence).toBe('');
    expect(learnerRows.every((x) => x.mode === 'active')).toBe(true);
    expect(learnerRows.filter((x) => x.session === 'sesC').length).toBe(2);
    const denials = rows.filter((x) => x.point === 'agent-type');
    expect(denials.length).toBe(4);
    const byTime = Object.fromEntries(denials.map((x) => [x.ts, x.result]));
    expect(byTime[`${D}T12:00:00.000Z`]).toBe('executed');
    expect(byTime[`${D}T12:02:00.000Z`]).toBe('ignored');
    expect(byTime[`${D}T12:03:00.000Z`]).toBe('ignored');
    expect(byTime[`${D}T13:00:00.000Z`]).toBe('undetermined');
    expect(denials.some((x) => x.ts === `${D}T12:05:00.000Z`)).toBe(false);
  });

  it('JSON summary: counts, undetermined outside the denominator, groups, thresholds, incomplete window', () => {
    build();
    const w = run(['--json']);
    expect(w.code).toBe(0);
    const j = JSON.parse(w.stdout);
    expect(j.journal_rows.applied).toBe(8);
    expect(j.journal_rows.applied_files).toBe(2);
    expect(j.journal_rows.agent_type).toBe(6);
    const learnerPoint = j.points.find((p: { point: string }) => p.point === 'learner-extraction');
    expect(learnerPoint).toBeDefined();
    expect(learnerPoint.total.n).toBe(7);
    expect(learnerPoint.total.executed).toBe(2);
    expect(learnerPoint.total.ignored).toBe(4);
    expect(learnerPoint.total.undetermined).toBe(1);
    expect(learnerPoint.total.labelled).toBe(6);
    expect(learnerPoint.total.window_incomplete).toBe(1);
    expect(learnerPoint.total.coverage.k).toBe(6);
    expect(learnerPoint.total.coverage.n).toBe(7);
    expect(learnerPoint.total.executed_share.k).toBe(2);
    expect(learnerPoint.total.executed_share.n).toBe(6);
    expect(learnerPoint.total.assessment).toBe('too little data');
    const groups = Object.fromEntries(learnerPoint.groups.map((g: { spec_version: string }) => [g.spec_version, g]));
    expect(learnerPoint.groups.length).toBe(2);
    expect(groups['no field'].n).toBe(5);
    expect(groups['no field'].executed).toBe(2);
    expect(groups['no field'].undetermined).toBe(1);
    expect(groups.abc123.n).toBe(2);
    expect(groups.abc123.ignored).toBe(2);
    expect(groups.abc123.jev_model).toBe('model-x');
    expect(groups['no field'].thresholds.last10).toEqual({ ignored: 2, labelled: 4, of_last: 5, c_percent: 70, note: 'threshold (c) 70 %: unapproved proposal, a number only' });
    const agentTypePoint = j.points.find((p: { point: string }) => p.point === 'agent-type');
    expect(agentTypePoint.total.n).toBe(5);
    expect(agentTypePoint.total.executed).toBe(1);
    expect(agentTypePoint.total.ignored).toBe(2);
    expect(agentTypePoint.total.undetermined).toBe(1);
    expect(agentTypePoint.total.would_deny).toBe(1);
  });

  it('--session timeline in ts order, labels and a dash for points without a label, no hint text in output', () => {
    build();
    const w = run(['--json', '--session', 'sesA']);
    expect(w.code).toBe(0);
    const j = JSON.parse(w.stdout);
    expect(j.session).toBe('sesA');
    const timeline = j.session_timeline;
    // sesA: 1 learner row (10:00), 6 agent-type rows (12:00 to 13:00), 1 loop-continuation row (14:00)
    expect(timeline.length).toBe(8);
    const times = timeline.map((z: { ts: string }) => z.ts);
    expect(times).toEqual([...times].sort());
    expect(timeline[0].point).toBe('learner-extraction');
    expect(timeline[0].label).toBe('executed');
    expect(timeline[0].mode).toBe('active');
    const shadowRow = timeline.find((z: { ts: string }) => z.ts === `${D}T12:05:00.000Z`);
    expect(shadowRow.label).toBe('-');
    expect(shadowRow.mode).toBe('shadow');
    const loop = timeline.find((z: { point: string }) => z.point === 'loop-continuation');
    expect(loop).toBeDefined();
    expect(loop.label).toBe('-');
    // output (stdout and TSV) without the hint text: the unique marker from the fixture is absent
    const tsvPath = join(base, 'session.tsv');
    const plain = run(['--tsv', tsvPath, '--session', 'sesA']);
    const tsvText = readFileSync(tsvPath, 'utf8');
    expect(plain.stdout.includes('UNIQUE-HINT-TEXT-MARKER')).toBe(false);
    expect(tsvText.includes('UNIQUE-HINT-TEXT-MARKER')).toBe(false);
    expect(plain.stdout.includes('<command-name>')).toBe(false);
    expect(plain.stdout.includes('begin')).toBe(false);
  });

  it('exit code 2 and the unreadable-row counter', () => {
    build();
    const none = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    expect(none.status).toBe(2);
    expect(none.stderr).toContain('usage');
    expect(run(['--unknown-option']).code).toBe(2);
    expect(run(['--from', 'yesterday']).code).toBe(2);
    const missing = spawnSync(process.execPath, [SCRIPT, '--journal', join(base, 'missing'), '--transcripts', transcripts], { encoding: 'utf8' });
    expect(missing.status).toBe(2);
    // a broken JSON row in applied: skipped and counted separately
    writeFileSync(join(journal, 'applied.jsonl'), '{broken\n' + readFileSync(join(journal, 'applied.jsonl'), 'utf8'));
    const w = run(['--json']);
    expect(w.code).toBe(0);
    const j = JSON.parse(w.stdout);
    expect(j.unreadable_rows).toBe(1);
    expect(j.points.find((p: { point: string }) => p.point === 'learner-extraction').total.n).toBe(7);
  });

  it('/remember only at the start of the text or inside <command-name>; a deny without session_id is undetermined', () => {
    mkdirSync(join(transcripts, 'proj'), { recursive: true });
    const learnerRow = (ts: string, session: string) => JSON.stringify({ ts: `${D}T${ts}:00.000Z`, point: 'learner-extraction', session_id: session, applied: { noul: 0.9 } });
    writeFileSync(join(journal, 'applied.jsonl'), [learnerRow('10:00', 'sesQuote'), learnerRow('10:00', 'sesSlash'), learnerRow('10:00', 'sesTag')].join('\n') + '\n');
    // a deny without session_id, followed by an allow without session_id: without the rule the deny would get executed from a missing session
    writeFileSync(join(journal, 'agent-type.jsonl'), [agentType('12:00', 'deny', null as unknown as string), agentType('12:01', 'allow', null as unknown as string)].join('\n') + '\n');
    writeFileSync(join(transcripts, 'proj', 'sesQuote.jsonl'), [entry('09:59', 'user', 'start'), entry('10:05', 'user', 'see skills/remember/SKILL.md after it'), entry('10:10', 'user', 'x'), entry('10:15', 'user', 'y')].join('\n') + '\n');
    writeFileSync(join(transcripts, 'proj', 'sesSlash.jsonl'), [entry('09:59', 'user', 'start'), entry('10:05', 'user', '/remember save a note')].join('\n') + '\n');
    writeFileSync(join(transcripts, 'proj', 'sesTag.jsonl'), [entry('09:59', 'user', 'start'), entry('10:05', 'user', 'something first'), entry('10:10', 'user', 'before <command-name>/oh-my-claudecode:remember</command-name> after')].join('\n') + '\n');
    const tsvPath = join(base, 'remember.tsv');
    const w = run(['--json', '--tsv', tsvPath]);
    expect(w.code, `exit 0, stderr: ${w.stderr}`).toBe(0);
    const rows = tsvRows(readFileSync(tsvPath, 'utf8'));
    const resultBySession = Object.fromEntries(rows.filter((x) => x.point === 'learner-extraction').map((x) => [x.session, x.result]));
    expect(resultBySession.sesQuote).toBe('ignored');
    expect(resultBySession.sesSlash).toBe('executed');
    expect(resultBySession.sesTag).toBe('executed');
    const denials = rows.filter((x) => x.point === 'agent-type');
    expect(denials.length).toBe(1);
    expect(denials[0].result).toBe('undetermined');
  });

  it('subagent transcript (also one level deeper), unparsed does not decide, a mode outside the verdict', () => {
    const w1 = { ts: `${D}T10:00:00.000Z`, point: 'learner-extraction', session_id: 'sesS', agent_id: 'a1', applied: { noul: 0.9 } };
    const w2 = { ts: `${D}T10:10:00.000Z`, point: 'learner-extraction', session_id: 'sesS', agent_id: 'a2', applied: { noul: 0.8 } };
    const w3 = { ts: `${D}T10:20:00.000Z`, point: 'learner-extraction', session_id: 'sesS', mode: 'degraded', applied: { noul: 0.7 } };
    const entriesA1 = [entry('09:59', 'user', 'start'), JSON.stringify({ type: 'assistant', timestamp: `${D}T10:00:20.000Z`, message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'remember' } }] } })];
    writeFileSync(join(journal, 'applied.jsonl'), [w1, w2, w3].map((x) => JSON.stringify(x)).join('\n') + '\n');
    mkdirSync(join(transcripts, 'proj', 'sesS', 'subagents', 'deeper'), { recursive: true });
    writeFileSync(join(transcripts, 'proj', 'sesS', 'subagents', 'deeper', 'agent-a1.jsonl'), entriesA1.join('\n') + '\n');
    const entriesA2 = [entry('10:10', 'user', 'start2'), JSON.stringify({ type: 'assistant', timestamp: `${D}T10:10:20.000Z`, message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'oh-my-claudecode:remember' } }] } })];
    writeFileSync(join(transcripts, 'proj', 'sesS', 'subagents', 'agent-a2.jsonl'), entriesA2.join('\n') + '\n');
    writeFileSync(join(journal, 'agent-type.jsonl'), [agentType('12:00', 'deny'), agentType('12:01', 'unparsed')].join('\n') + '\n');
    const w = run(['--json']);
    expect(w.code, `exit 0, stderr: ${w.stderr}`).toBe(0);
    const j = JSON.parse(w.stdout);
    const learnerPoint = j.points.find((x: { point: string }) => x.point === 'learner-extraction');
    // w3 (mode degraded) outside the denominator: n = 3, labelled only 2
    expect(learnerPoint.total.n).toBe(3);
    expect(learnerPoint.total.labelled).toBe(2);
    expect(learnerPoint.total.outside_verdict).toBe(1);
    expect(learnerPoint.total.executed).toBe(2);
    const denialPoint = j.points.find((x: { point: string }) => x.point === 'agent-type');
    expect(denialPoint.total.undetermined).toBe(1);
  });

  it('chain with wilson_threshold: the TSV of the labels tool is the input of the threshold tool', () => {
    build();
    const tsvPath = join(base, 'chain.tsv');
    const first = run(['--tsv', tsvPath]);
    expect(first.code, `exit 0, stderr: ${first.stderr}`).toBe(0);
    const rowCount = readFileSync(tsvPath, 'utf8').trimEnd().split('\n').length - 1;
    expect(rowCount).toBe(11);
    const second = spawnSync(process.execPath, [WILSON, '--input', tsvPath, '--target', '0.5', '--json'], { encoding: 'utf8' });
    expect(second.status, `threshold tool exit 0, stderr: ${second.stderr}`).toBe(0);
    const j = JSON.parse(second.stdout);
    expect(j.hasConfidence).toBe(true);
    expect(j.rowsTotal).toBe(rowCount);
    const groupN = j.groups.reduce((s: number, g: { n: number }) => s + g.n, 0);
    const excluded = Object.values(j.excludedModes).reduce((a: number, b) => a + (b as number), 0) as number;
    expect(groupN + j.undetermined + excluded + j.invalid + j.invalidConfidence + j.badFormat).toBe(j.rowsTotal);
    expect(j.undetermined).toBe(2);
    const denials = j.groups.find((g: { label: string[] }) => g.label[0] === 'agent-type');
    expect(denials).toBeDefined();
    expect(denials.noConfidence).not.toBeNull();
    expect(denials.noConfidence.n).toBe(3);
    expect(denials.noConfidence.k).toBe(1);
    expect(denials.noConfidence.status).toBe('too little data');
    expect(denials.n).toBe(3);
    expect(denials.undetermined).toBe(1);
    const learner = j.groups.find((g: { label: string[] }) => g.label[0] === 'learner-extraction' && g.label[1] === 'no field');
    expect(learner).toBeDefined();
    expect(learner.status).toBe('no threshold');
    expect(learner.table).not.toBeNull();
  });

  it('a rotated journal file with a process-id suffix (-<pid>) is read like the other rotated files', () => {
    build();
    writeFileSync(join(journal, 'applied-20261114-093500-4242.jsonl'), learner('09:35', 'sesPid', {}, { noul: 0.61 }) + '\n');
    writeFileSync(join(transcripts, 'proj', 'sesPid.jsonl'), [entry('09:59', 'user', 'a'), entry('10:05', 'user', 'b')].join('\n') + '\n');
    const tsvPath = join(base, 'pid.tsv');
    const w = run(['--tsv', tsvPath]);
    expect(w.code, `exit 0, stderr: ${w.stderr}`).toBe(0);
    const rows = tsvRows(readFileSync(tsvPath, 'utf8'));
    const pidRows = rows.filter((x) => x.session === 'sesPid');
    expect(pidRows.length).toBe(1);
    expect(pidRows[0].result).toBe('ignored');
    expect(pidRows[0].confidence).toBe('0.61');
  });

  it('confidence is read from both journal shapes: applied.noul (this port) and applied.action.noul (dev)', () => {
    const row = (session: string, applied: Record<string, unknown>) =>
      JSON.stringify({ ts: `${D}T10:00:00.000Z`, point: 'learner-extraction', session_id: session, applied });
    writeFileSync(join(journal, 'applied.jsonl'), [
      row('sesFlat', { noul: 0.3 }),
      row('sesAction', { action: { from: 'none', to: 'hint', noul: 0.6 } }),
      row('sesNone', { action: { from: 'none', to: 'hint' } }),
    ].join('\n') + '\n');
    const tsvPath = join(base, 'shapes.tsv');
    const w = run(['--tsv', tsvPath]);
    expect(w.code, `exit 0, stderr: ${w.stderr}`).toBe(0);
    const rows = tsvRows(readFileSync(tsvPath, 'utf8'));
    const bySession = Object.fromEntries(rows.map((x) => [x.session, x.confidence]));
    expect(bySession.sesFlat).toBe('0.3');
    expect(bySession.sesAction).toBe('0.6');
    expect(bySession.sesNone).toBe('');
  });

  it('--from filter removes rows before the boundary', () => {
    build();
    const w = run(['--json', '--from', `${D}T11:00:00.000Z`]);
    expect(w.code).toBe(0);
    const j = JSON.parse(w.stdout);
    const points = j.points.map((p: { point: string }) => p.point);
    expect(points).not.toContain('learner-extraction');
    expect(points).toContain('agent-type');
    expect(j.points.find((p: { point: string }) => p.point === 'agent-type').total.n).toBe(5);
  });
});
