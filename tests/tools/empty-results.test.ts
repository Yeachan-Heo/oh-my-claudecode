import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Tests for tools/diagnostics/empty_results.py on a synthetic fixture (temp directory only, no network).
// The script needs python3; the suite is skipped when python3 is not installed.
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'diagnostics', 'empty_results.py');
const hasPython3 = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;
if (!hasPython3) console.warn('empty_results.py tests are skipped: python3 is not available');

// Content markers of the fixture: the script must print none of them (no prompt, result or subject content).
const MARKER_PROMPT = 'MARKER-prompt';
const MARKER_RESULT = 'MARKER-result';
const MARKER_SUBJECT = 'MARKER-subject';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// Transcript row builders: the timestamp field like in real rows; field 'ts' builds the fallback row (old data).
const assistant = (time: string, id: string, content: unknown[], timeField = 'timestamp') => JSON.stringify({
  [timeField]: time, type: 'assistant', message: { id, role: 'assistant', content },
}) + '\n';
const user = (time: string, content: unknown, timeField = 'timestamp') => JSON.stringify({
  [timeField]: time, type: 'user', message: { role: 'user', content },
}) + '\n';
const textBlock = (text: string) => ({ type: 'text', text });
const agentBlock = (id: string, name = 'Agent') => ({ type: 'tool_use', id, name, input: {} });
const bashBlock = (id: string) => ({ type: 'tool_use', id, name: 'Bash', input: {} });
const taskStopBlock = (id: string, input: unknown) => ({ type: 'tool_use', id, name: 'TaskStop', input });
const resultBlock = (toolUseId: string, content: unknown) => ({ type: 'tool_result', tool_use_id: toolUseId, content });
const meta = (toolUseId: string, agentId: string) => JSON.stringify({ toolUseId, agentId, name: 'executor' });
const write = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

const KILLED_NOTIFICATION = (agentId: string) =>
  `Background task stopped: <task-notification><task-id>${agentId}</task-id>`
  + '<status>killed</status><usage>was stopped</usage></task-notification>';
const LAUNCH = (agentId: string) => `Async agent launched successfully. agentId: ${agentId}. Name: executor.`;

describe.skipIf(!hasPython3)('empty_results.py', () => {
  let base: string;
  let transcripts: string;
  let teams: string;

  const run = (extra: string[] = []) => spawnSync('python3', ['-I', SCRIPT, ...extra], { encoding: 'utf8' });
  const readJson = (file: string): Json => JSON.parse(readFileSync(file, 'utf8'));

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'empty-results-'));
    transcripts = join(base, 'transcripts');
    teams = join(base, 'teams');

    // ===== part transcripts: the main session and subagents =====
    write(join(transcripts, 'proj1', 'ses-A.jsonl'),
      user('2026-11-14T10:00:00.000Z', `${MARKER_PROMPT}: start the agents`)
      // tu-2: transcript with full text, non-empty tool_result: non-empty
      + assistant('2026-11-14T10:01:00.000Z', 'm-1', [textBlock('Work plan.'), agentBlock('tu-2')])
      + user('2026-11-14T10:01:30.000Z', [resultBlock('tu-2', `full result text ${MARKER_RESULT}`)])
      // tu-3: transcript with only the initial prompt, no tool_result: prompt_only
      + assistant('2026-11-14T10:03:00.000Z', 'm-2', [agentBlock('tu-3')])
      // tu-4: transcript with a tool_use and no text, non-empty tool_result: tool_use_only
      + assistant('2026-11-14T10:04:00.000Z', 'm-3', [agentBlock('tu-4')])
      + user('2026-11-14T10:04:30.000Z', [resultBlock('tu-4', 'text result from the main session')])
      // tu-5: transcript with text, empty tool_result (block list): empty_tool_result
      + assistant('2026-11-14T10:05:00.000Z', 'm-4', [agentBlock('tu-5')])
      + user('2026-11-14T10:05:30.000Z', [resultBlock('tu-5', [textBlock('   ')])])
      // tu-6: no meta and no tool_result: missing_transcript (outside the denominator)
      + assistant('2026-11-14T10:06:00.000Z', 'm-5', [agentBlock('tu-6')])
      // tu-7: no transcript, non-empty tool_result: in the denominator, non-empty
      + assistant('2026-11-14T10:07:00.000Z', 'm-6', [agentBlock('tu-7')])
      + user('2026-11-14T10:07:30.000Z', [resultBlock('tu-7', 'text that rescues agent tu-7')])
      // Bash: not Agent/Task, not counted
      + assistant('2026-11-14T10:07:40.000Z', 'm-7', [bashBlock('bt-1')])
      + user('2026-11-14T10:07:45.000Z', [resultBlock('bt-1', 'ls -la')])
      // tu-9: the Task alias with full text: non-empty
      + assistant('2026-11-14T10:08:00.000Z', 'm-8', [agentBlock('tu-9', 'Task')])
      + user('2026-11-14T10:08:30.000Z', [resultBlock('tu-9', 'full Task result')])
      // tu-20: outside the main range (range filter test)
      + assistant('2026-11-15T09:00:00.000Z', 'm-9', [agentBlock('tu-20')])
      + user('2026-11-15T09:00:30.000Z', [resultBlock('tu-20', 'result after the range')])
      + assistant('2026-11-14T10:09:00.000Z', 'm-10', [textBlock('End of session.')]));

    // ses-Z: a call with a valid timestamp: bad_ts = 0
    write(join(transcripts, 'proj1', 'ses-Z.jsonl'),
      assistant('2026-11-14T10:10:00.000Z', 'm-z', [agentBlock('tu-40')])
      + user('2026-11-14T10:10:30.000Z', [resultBlock('tu-40', 'non-empty result tu-40')]));

    // subagents (meta with toolUseId links to the call; the transcript sits next to it)
    const sub = (name: string) => join(transcripts, 'proj1', 'ses-A', 'subagents', name);
    write(sub('agent-a1.meta.json'), meta('tu-2', 'a1'));
    // agent-a1 issues its own Agent call tu-w1: a call from a subagent transcript counts the same way;
    // the sub-subagent c1 has meta and a transcript
    write(sub('agent-a1.jsonl'),
      assistant('2026-11-14T10:01:20.000Z', 'sa-1', [textBlock('Full agent report.')])
      + assistant('2026-11-14T10:01:40.000Z', 'sa-1b', [agentBlock('tu-w1')]));
    write(sub(join('w1', 'agent-c1.meta.json')), meta('tu-w1', 'c1'));
    write(sub(join('w1', 'agent-c1.jsonl')),
      assistant('2026-11-14T10:01:50.000Z', 'sc-1', [textBlock('Sub-subagent report.')]));
    // meta outside subagents: ignored (the index pattern requires subagents/)
    write(join(transcripts, 'proj1', 'outside-subagents', 'agent-x.meta.json'), meta('tu-100', 'ax'));
    // subagent a2 with only the initial prompt (no assistant message)
    write(sub('agent-a2.meta.json'), meta('tu-3', 'a2'));
    write(sub('agent-a2.jsonl'), user('2026-11-14T10:03:20.000Z', `initial prompt of subagent a2 ${MARKER_PROMPT}`));
    // subagent a3: the assistant called tools and gave no text (an empty text block does not count)
    write(sub('agent-a3.meta.json'), meta('tu-4', 'a3'));
    write(sub('agent-a3.jsonl'),
      assistant('2026-11-14T10:04:10.000Z', 'sa-3a', [bashBlock('sa-3b')])
      + assistant('2026-11-14T10:04:20.000Z', 'sa-3b', [textBlock('')]));
    // subagent a4: has text, but the tool_result in the main session is empty
    write(sub('agent-a4.meta.json'), meta('tu-5', 'a4'));
    write(sub('agent-a4.jsonl'), assistant('2026-11-14T10:05:20.000Z', 'sa-4', [textBlock('Work report.')]));
    // tu-9: the Task alias
    write(sub('agent-a9.meta.json'), meta('tu-9', 'a9'));
    write(sub('agent-a9.jsonl'), assistant('2026-11-14T10:08:20.000Z', 'sa-9', [textBlock('Task report.')]));
    // tu-20: the agent after the range (non-empty in the narrow window)
    write(sub('agent-a20.meta.json'), meta('tu-20', 'a20'));
    write(sub('agent-a20.jsonl'), assistant('2026-11-14T10:08:20.000Z', 'sa-20', [textBlock('Report a20.')]));

    // ===== part team: a team with tasks =====
    const tasks = join(teams, 'team1', 'tasks');
    const task = (id: string, override: Record<string, unknown> = {}) => JSON.stringify({
      id, subject: `${MARKER_SUBJECT}-${id}`,
      status: 'completed', created_at: '2026-11-14T07:00:00Z', completed_at: '2026-11-14T08:00:00Z',
      result: 'done',
      ...override,
    });
    write(join(tasks, 'task-1.json'), task('task-1'));
    write(join(tasks, 'task-2.json'), task('task-2', { result: undefined, completed_at: '2026-11-14T08:05:00Z' }));
    write(join(tasks, 'task-3.json'), task('task-3', { result: '  ', completed_at: '2026-11-14T08:10:00Z' }));
    write(join(tasks, 'task-4.json'), task('task-4', { status: 'failed', error: 'something went wrong', result: undefined, completed_at: '2026-11-14T08:15:00Z' }));
    write(join(tasks, '5.json'), task('task-5', { status: 'failed', error: '', result: undefined, completed_at: '2026-11-14T08:20:00Z' }));
    write(join(tasks, 'task-6.json'), task('task-6', { status: 'in_progress', result: undefined, completed_at: undefined }));
    write(join(tasks, 'task-7.json'), task('task-7', { completed_at: '2026-11-13T09:00:00Z' }));
    write(join(tasks, 'task-8.json'), task('task-8', { result: 'double', completed_at: '2026-11-14T08:30:00Z' }));
    write(join(tasks, '8.json'), task('task-8-duplicate', { result: 'duplicate', completed_at: '2026-11-14T08:30:00Z' }));
    write(join(tasks, 'task-12.json'), 'this is not JSON');
    write(join(tasks, 'note.json'), JSON.stringify({ id: 'task-13', status: 'completed', completed_at: '2026-11-14T08:35:00Z', result: 'ignored' }));
    // task-9: the narrow window (15.11): empty
    write(join(tasks, 'task-9.json'), task('task-9', { result: '', completed_at: '2026-11-15T08:30:00Z' }));
    // team2: a team directory without tasks/ (counter of team directories)
    mkdirSync(join(teams, 'team2'));
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('exits 2 with a usage message when no input is given', () => {
    const r = run();
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage/);
  });

  it('--help exits 0 and lists the options', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--transcripts');
    expect(r.stdout).toContain('--intent');
  });

  it('Wilson vectors (lower bound 1.645 and interval 1.96, tolerance 1e-4)', () => {
    const r = run(['--wilson-vectors']);
    expect(r.status, r.stderr).toBe(0);
    const v: Json = JSON.parse(r.stdout);
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;
    expect(near(v['22/22'].lower_1_645, 0.8905)).toBe(true);
    expect(near(v['20/22'].lower_1_645, 0.7591)).toBe(true);
    expect(near(v['18/22'].lower_1_645, 0.651)).toBe(true);
    expect(near(v['10/10'].lower_1_645, 0.787)).toBe(true);
    expect(near(v['245/245'].lower_1_645, 0.9891)).toBe(true);
    expect(near(v['15/30'].lower_1_645, 0.3562)).toBe(true);
    expect(near(v['941/1019'].lower_1_645, 0.9086)).toBe(true);
    expect(near(v['0/30'].lower_1_645, 0)).toBe(true);
    expect(near(v['22/22'].interval_1_96[0], 0.8513) && near(v['22/22'].interval_1_96[1], 1)).toBe(true);
    expect(near(v['20/22'].interval_1_96[0], 0.7218) && near(v['20/22'].interval_1_96[1], 0.9747)).toBe(true);
    expect(near(v['15/30'].interval_1_96[0], 0.3315) && near(v['15/30'].interval_1_96[1], 0.6685)).toBe(true);
    expect(near(v['941/1019'].interval_1_96[0], 0.9055) && near(v['941/1019'].interval_1_96[1], 0.9382)).toBe(true);
  });

  it('main run: parts transcripts and team, TSV, JSON, no content in the output', () => {
    const tsvPath = join(base, 'result.tsv');
    const jsonPath = join(base, 'result.json');
    const r = run(['--transcripts', transcripts, '--teams', teams, '--tsv', tsvPath, '--json', jsonPath,
      '--min-support', '30', '--from', '2026-11-14T00:00:00Z', '--to', '2026-11-15T00:00:00Z']);
    expect(r.status, r.stderr).toBe(0);
    const out = readJson(jsonPath);

    // transcripts: n = 8 (9 calls minus tu-6 without a transcript and tool_result), k = 3
    // (9 calls: 7 from ses-A + tu-40 from ses-Z + tu-w1 from the subagent transcript agent-a1)
    const c0 = out.part_transcripts;
    expect(c0.n).toBe(8);
    expect(c0.k).toBe(3);
    expect(c0.counters.bad_ts).toBe(0);
    expect(Math.abs(c0.rate - 0.375)).toBeLessThan(1e-9);
    expect(c0.wilson_1_96[0]).toBeGreaterThan(0);
    expect(c0.wilson_1_96[0]).toBeLessThanOrEqual(c0.rate);
    expect(c0.rate).toBeLessThanOrEqual(c0.wilson_1_96[1]);
    expect(c0.wilson_lower_1_645).toBeLessThanOrEqual(c0.rate);
    expect(c0.threshold).toBe('no threshold (too little data)');
    expect(c0.subtotals).toEqual({ prompt_only: 1, empty_tool_result: 1, tool_use_only: 1, non_empty: 5, missing_transcript: 1 });
    // stop measure: the main fixture has no stops
    expect(c0.stops_by_source).toEqual({ parent_taskstop: 0, interrupt: 0, killed_other: 0 });
    expect(c0.stopped_without_report.k).toBe(0);
    expect(c0.stopped_without_report.n).toBe(8);
    expect(c0.stopped_without_report.rate).toBe(0);
    expect(c0.intent.unclassified).toBe(0);
    expect(c0.counters.sessions).toBe(2); // ses-A + ses-Z
    expect(c0.counters.subagent_transcripts).toBe(7); // 6 in subagents/ + 1 in subagents/w1/
    expect(c0.counters.calls_in_range).toBe(9);
    expect(c0.counters.duplicates).toBe(0);
    // identifiers of the empty ones: tu-3, tu-4, tu-5
    expect(c0.tsv_rows.map((x: Json) => x.id).sort()).toEqual(['tu-3', 'tu-4', 'tu-5']);
    const kinds0 = Object.fromEntries(c0.tsv_rows.map((x: Json) => [x.id, x.kind]));
    expect(kinds0['tu-3']).toBe('prompt_only');
    expect(kinds0['tu-4']).toBe('tool_use_only');
    expect(kinds0['tu-5']).toBe('empty_tool_result');
    expect(c0.tsv_rows.every((x: Json) => x.part === 'transcripts')).toBe(true);

    // team: n = 6 finished in the range, k = 2 empty
    const ca = out.part_team;
    expect(ca.n).toBe(6);
    expect(ca.k).toBe(2);
    expect(ca.threshold).toBe('no threshold (too little data)');
    expect(ca.subtotals).toEqual({ completed_with_result: 2, failed_with_error: 1, failed_without_error: 1, other_statuses: 1 });
    expect(ca.counters.team_dir_count).toBe(2); // team1 (with tasks) and team2 (empty)
    expect(ca.counters.teams_with_tasks).toBe(1);
    expect(ca.counters.files).toBe(12);
    expect(ca.counters.other_names).toBe(1); // note.json skipped with a counter
    expect(ca.counters.duplicate_files).toBe(1); // 8.json after task-8.json
    expect(ca.counters.bad_json).toBe(1); // task-12.json
    expect(ca.counters.outside_range).toBe(2); // task-7 (13.11) and task-9 (15.11T08:30 after --to)
    expect(ca.counters.bad_ts).toBe(0);
    expect(ca.tsv_rows.map((x: Json) => x.id).sort()).toEqual(['task-2', 'task-3']);
    expect(ca.tsv_rows.every((x: Json) => x.part === 'team' && x.kind === 'empty_result')).toBe(true);
    expect(ca.tsv_rows.every((x: Json) => x.context === 'team1')).toBe(true);
    // the row ts is completed_at
    expect(ca.tsv_rows.every((x: Json) => x.ts.startsWith('2026-11-14T08:'))).toBe(true);

    // sum
    expect(out.empty_result_sum).toEqual({ transcripts: '3', team: '2' });
    expect(r.stdout).toMatch(/empty-result sum: transcripts = 3, team = 2 \(numbers only\)/);
    // the TSV message separates empty and stopped
    expect(r.stdout).toMatch(/TSV: .* \(5 rows: 5 empty, 0 stopped\)/);

    // TSV: header + 5 rows of empty ones (3+2), columns without the removed stop-text column
    const tsvText = readFileSync(tsvPath, 'utf8');
    const tsv = tsvText.replace(/\n$/, '').split('\n');
    expect(tsv.length).toBe(6);
    expect(tsv[0]).toBe(['part', 'kind', 'context', 'id', 'ts', 'stop_source', 'stop_evidence', 'intent'].join('\t'));
    const header = tsv[0].split('\t');
    const rows = tsv.slice(1).map((l) => l.split('\t'));
    expect(rows.length).toBe(5);
    expect(rows.every((p) => p.length === 8), `rows with a wrong field count: ${JSON.stringify(rows.filter((p) => p.length !== 8))}`).toBe(true);
    // the main fixture has no stops: the last three columns are empty in every row
    expect(rows.every((p) => p.slice(5).every((v) => v === ''))).toBe(true);
    expect(rows.map((p) => p[header.indexOf('id')]).sort()).toEqual(['task-2', 'task-3', 'tu-3', 'tu-4', 'tu-5']);
    expect(rows.find((p) => p[header.indexOf('id')] === 'tu-3')![header.indexOf('context')]).toBe('proj1/ses-A.jsonl');
    expect(rows.find((p) => p[header.indexOf('id')] === 'task-2')![header.indexOf('context')]).toBe('team1');

    // no content in the outputs (prompts, results, subject)
    const everything = r.stdout + tsvText + readFileSync(jsonPath, 'utf8');
    for (const marker of [MARKER_PROMPT, MARKER_RESULT, MARKER_SUBJECT]) {
      expect(everything.includes(marker), `fixture content leaked into the output: ${marker}`).toBe(false);
    }
  });

  it('the --from filter cuts both parts', () => {
    const jsonPath = join(base, 'result2.json');
    const r = run(['--transcripts', transcripts, '--teams', teams, '--tsv', join(base, 'result2.tsv'), '--json', jsonPath,
      '--min-support', '5', '--from', '2026-11-15T08:00:00Z']);
    expect(r.status, r.stderr).toBe(0);
    const out = readJson(jsonPath);
    // transcripts: only tu-20 (15.11T09:00), non-empty; bad_ts = 0
    expect(out.part_transcripts.n).toBe(1);
    expect(out.part_transcripts.k).toBe(0);
    expect(out.part_transcripts.subtotals.non_empty).toBe(1);
    expect(out.part_transcripts.counters.bad_ts).toBe(0);
    expect(out.part_transcripts.counters.calls_in_range).toBe(1);
    // team: only task-9 (15.11T08:30), empty
    expect(out.part_team.n).toBe(1);
    expect(out.part_team.k).toBe(1);
    expect(out.part_team.tsv_rows[0].id).toBe('task-9');
    // --min-support 5: n = 1 still has no threshold in both parts
    expect(out.part_transcripts.threshold).toBe('no threshold (too little data)');
    expect(out.part_team.threshold).toBe('no threshold (too little data)');
    expect(out.empty_result_sum).toEqual({ transcripts: '0', team: '1' });
  });

  it('a measured part with n = 0 is unmeasured in the sum, not 0', () => {
    const jsonPath = join(base, 'result4.json');
    const r = run(['--transcripts', transcripts, '--teams', teams, '--json', jsonPath, '--from', '2026-11-16T00:00:00Z']);
    expect(r.status, r.stderr).toBe(0);
    const out = readJson(jsonPath);
    expect(out.part_transcripts.n).toBe(0);
    expect(out.part_transcripts.k).toBe(0);
    expect(out.part_transcripts.rate).toBeNull();
    expect(out.part_transcripts.wilson_1_96).toBeNull();
    expect(out.part_team.n).toBe(0);
    expect(out.part_team.k).toBe(0);
    expect(out.empty_result_sum).toEqual({
      transcripts: 'unmeasured (no data in the window: n = 0)',
      team: 'unmeasured (no data in the window: n = 0)',
    });
    expect(r.stdout).toMatch(/empty-result sum: transcripts = unmeasured \(no data in the window: n = 0\), team = unmeasured \(no data in the window: n = 0\)/);
  });

  it('reads the timestamp field, with ts as the fallback', () => {
    // Mini fixture: a session with the fallback ts field and a session with a bad timestamp.
    const dir = join(base, 'ts');
    write(join(dir, 'proj', 'ses-L.jsonl'),
      assistant('2026-11-14T12:00:00.000Z', 'm-fallback-1', [agentBlock('tu-fallback-1')], 'ts')
      + user('2026-11-14T12:00:30.000Z', [resultBlock('tu-fallback-1', 'non-empty fallback result')], 'ts'));
    write(join(dir, 'proj', 'ses-L', 'subagents', 'agent-al.meta.json'), meta('tu-fallback-1', 'al'));
    write(join(dir, 'proj', 'ses-L', 'subagents', 'agent-al.jsonl'),
      assistant('2026-11-14T12:00:20.000Z', 'sal-1', [textBlock('Legacy report.')], 'ts'));
    // bad timestamp: skipped with the bad_ts counter
    write(join(dir, 'proj', 'ses-B.jsonl'), assistant('no-timestamp-here', 'm-fallback-2', [agentBlock('tu-fallback-2')]));
    const r = run(['--transcripts', dir, '--json', join(dir, 'result.json')]);
    expect(r.status, r.stderr).toBe(0);
    const out = readJson(join(dir, 'result.json'));
    expect(out.part_transcripts.counters.sessions).toBe(2);
    expect(out.part_transcripts.counters.bad_ts).toBe(1); // a bad timestamp counts separately
    expect(out.part_transcripts.counters.calls_in_range).toBe(1); // fallback ts: the call is counted
    expect(out.part_transcripts.n).toBe(1);
    expect(out.part_transcripts.k).toBe(0);
    expect(out.part_transcripts.subtotals.non_empty).toBe(1);
  });

  it('a part without its input is unmeasured, never 0', () => {
    const jsonPath = join(base, 'result3.json');
    const r = run(['--teams', teams, '--json', jsonPath]);
    expect(r.status, r.stderr).toBe(0);
    const out = readJson(jsonPath);
    expect(out.part_transcripts).toBeNull();
    expect(out.part_team.k).toBe(3); // without a range filter: task-2, task-3 and task-9 (15.11)
    expect(out.empty_result_sum).toEqual({ transcripts: 'unmeasured', team: '3' });
    expect(r.stdout).toMatch(/NOT MEASURED \(--transcripts not given\)/);
    expect(r.stdout).toMatch(/empty-result sum: transcripts = unmeasured, team = 3/);
  });

  it('exit code 2: a bad path, a bad range, a negative min-support', () => {
    const missing = join(base, 'no-such-directory');
    let r = run(['--transcripts', missing]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/is not a directory/);
    r = run(['--teams', missing]);
    expect(r.status).toBe(2);
    r = run(['--teams', teams, '--from', 'not-a-date']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/is not an ISO date/);
    r = run(['--teams', teams, '--min-support', '-1']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/must not be negative/);
  });

  it('stop measure: sources, precedence, stopped outside the empty count, intent', () => {
    const dir = join(base, 'stops');
    const sub = (name: string) => join(dir, 'proj3', 'ses-C', 'subagents', name);
    // ses-C: 7 background Agent calls with a launch message (agentId)
    write(join(dir, 'proj3', 'ses-C.jsonl'),
      user('2026-11-14T10:00:00.000Z', `${MARKER_PROMPT}: session with stopped agents`)
      // tz-1: TaskStop (task_id) + killed notification -> parent_taskstop
      + assistant('2026-11-14T10:01:00.000Z', 'mc-1', [agentBlock('tz-1')])
      + user('2026-11-14T10:01:30.000Z', [resultBlock('tz-1', LAUNCH('ag-1'))])
      + assistant('2026-11-14T10:02:00.000Z', 'mc-2', [taskStopBlock('ts-1', { task_id: 'ag-1' })])
      + user('2026-11-14T10:02:15.000Z', [resultBlock('ts-1', 'stopped')])
      // a second TaskStop of the same agent (shell_id): the trace is collapsed with a counter
      + assistant('2026-11-14T10:02:10.000Z', 'mc-2b', [taskStopBlock('ts-1b', { shell_id: 'ag-1' })])
      + user('2026-11-14T10:02:20.000Z', [resultBlock('ts-1b', 'stopped')])
      + user('2026-11-14T10:02:30.000Z', KILLED_NOTIFICATION('ag-1'))
      + assistant('2026-11-14T10:03:00.000Z', 'mc-3', [textBlock('I stopped this agent, another one took over.')])
      // tz-2: the subagent transcript ends with an interruption, no TaskStop -> interrupt
      + assistant('2026-11-14T10:04:00.000Z', 'mc-4', [agentBlock('tz-2')])
      + user('2026-11-14T10:04:30.000Z', [resultBlock('tz-2', LAUNCH('ag-2'))])
      // tz-3: killed notification without TaskStop and without an interruption -> killed_other
      + assistant('2026-11-14T10:05:00.000Z', 'mc-5', [agentBlock('tz-3')])
      + user('2026-11-14T10:05:30.000Z', [resultBlock('tz-3', LAUNCH('ag-3'))])
      + user('2026-11-14T10:05:40.000Z', KILLED_NOTIFICATION('ag-3'))
      // tz-4: a plain empty one without stop traces -> stays in the empty count (prompt_only)
      + assistant('2026-11-14T10:06:00.000Z', 'mc-6', [agentBlock('tz-4')])
      + user('2026-11-14T10:06:30.000Z', [resultBlock('tz-4', LAUNCH('ag-4'))])
      // tz-5: a subagent with full text -> non-empty (neither empty nor stopped)
      + assistant('2026-11-14T10:07:00.000Z', 'mc-7', [agentBlock('tz-5')])
      + user('2026-11-14T10:07:30.000Z', [resultBlock('tz-5', LAUNCH('ag-5'))])
      // tz-6: TaskStop by shell_id + an interrupted transcript -> parent_taskstop (precedence)
      + assistant('2026-11-14T10:08:00.000Z', 'mc-8', [agentBlock('tz-6')])
      + user('2026-11-14T10:08:30.000Z', [resultBlock('tz-6', LAUNCH('ag-6'))])
      + assistant('2026-11-14T10:09:00.000Z', 'mc-9', [taskStopBlock('ts-6', { shell_id: 'ag-6' })])
      + user('2026-11-14T10:09:20.000Z', [resultBlock('ts-6', 'stopped')])
      + assistant('2026-11-14T10:10:00.000Z', 'mc-10', [textBlock('I am splitting the work again.')])
      // tz-7: killed notification + an interrupted transcript, no TaskStop -> interrupt
      + assistant('2026-11-14T10:11:00.000Z', 'mc-11', [agentBlock('tz-7')])
      + user('2026-11-14T10:11:30.000Z', [resultBlock('tz-7', LAUNCH('ag-7'))])
      + user('2026-11-14T10:11:40.000Z', KILLED_NOTIFICATION('ag-7'))
      + assistant('2026-11-14T10:12:00.000Z', 'mc-12', [textBlock('End of session C.')]));

    // subagent transcripts (meta by toolUseId)
    write(sub('agent-ag-1.meta.json'), meta('tz-1', 'ag-1'));
    write(sub('agent-ag-1.jsonl'), assistant('2026-11-14T10:01:45.000Z', 'sa-c1', [bashBlock('sb-1')]));
    write(sub('agent-ag-2.meta.json'), meta('tz-2', 'ag-2'));
    write(sub('agent-ag-2.jsonl'),
      assistant('2026-11-14T10:04:40.000Z', 'sa-c2', [bashBlock('sb-2')])
      + user('2026-11-14T10:05:50.000Z', '[Request interrupted by user for tool use]'));
    write(sub('agent-ag-3.meta.json'), meta('tz-3', 'ag-3'));
    write(sub('agent-ag-3.jsonl'), user('2026-11-14T10:05:35.000Z', 'initial prompt of subagent ag-3'));
    write(sub('agent-ag-4.meta.json'), meta('tz-4', 'ag-4'));
    write(sub('agent-ag-4.jsonl'), user('2026-11-14T10:06:35.000Z', 'initial prompt of subagent ag-4'));
    write(sub('agent-ag-5.meta.json'), meta('tz-5', 'ag-5'));
    write(sub('agent-ag-5.jsonl'), assistant('2026-11-14T10:07:40.000Z', 'sa-c5', [textBlock('Full report of subagent ag-5.')]));
    write(sub('agent-ag-6.meta.json'), meta('tz-6', 'ag-6'));
    write(sub('agent-ag-6.jsonl'),
      assistant('2026-11-14T10:08:40.000Z', 'sa-c6', [bashBlock('sb-6')])
      + user('2026-11-14T10:09:45.000Z', '[Request interrupted by user]'));
    write(sub('agent-ag-7.meta.json'), meta('tz-7', 'ag-7'));
    write(sub('agent-ag-7.jsonl'),
      assistant('2026-11-14T10:11:35.000Z', 'sa-c7', [bashBlock('sb-7')])
      + user('2026-11-14T10:11:45.000Z', '[Request interrupted by user]'));

    // ===== run without --intent =====
    const w1 = run(['--transcripts', dir, '--json', join(dir, 'w1.json'), '--tsv', join(dir, 'w1.tsv')]);
    expect(w1.status, w1.stderr).toBe(0);
    const c0 = readJson(join(dir, 'w1.json')).part_transcripts;

    // denominator 7 calls (all with a transcript), only tz-4 is empty, 5 stopped
    expect(c0.n).toBe(7);
    expect(c0.k).toBe(1);
    expect(c0.stopped_without_report.k).toBe(5);
    expect(c0.stopped_without_report.n).toBe(7);
    expect(c0.stopped_without_report.rate).toBeGreaterThan(0);
    expect(c0.stopped_without_report.rate).toBeLessThan(1);
    expect(c0.subtotals).toEqual({ prompt_only: 1, empty_tool_result: 0, tool_use_only: 0, non_empty: 1, missing_transcript: 0 });
    expect(c0.stops_by_source).toEqual({ parent_taskstop: 2, interrupt: 2, killed_other: 1 });
    // the intent column is filled only with --intent
    expect(c0.intent.unclassified).toBe(5);
    expect(c0.tsv_rows.map((x: Json) => x.id)).toEqual(['tz-1', 'tz-2', 'tz-3', 'tz-4', 'tz-6', 'tz-7']);
    const byId: Record<string, Json> = Object.fromEntries(c0.tsv_rows.map((x: Json) => [x.id, x]));

    // source by precedence: parent_taskstop > interrupt > killed_other
    expect(byId['tz-1'].stop_source).toBe('parent_taskstop');
    expect(byId['tz-2'].stop_source).toBe('interrupt');
    expect(byId['tz-3'].stop_source).toBe('killed_other');
    expect(byId['tz-6'].stop_source).toBe('parent_taskstop');
    expect(byId['tz-7'].stop_source).toBe('interrupt');
    // a plain empty one: the stop columns are empty
    expect(byId['tz-4'].stop_source).toBe('');
    expect(byId['tz-4'].stop_evidence).toBe('');
    expect(byId['tz-4'].intent).toBe('');
    // all found traces in the evidence column; repeats collapsed with a counter
    expect(byId['tz-1'].stop_evidence).toBe('parent_taskstop x2; killed_notification');
    expect(byId['tz-2'].stop_evidence).toBe('subagent_interrupt');
    expect(byId['tz-3'].stop_evidence).toBe('killed_notification');
    expect(byId['tz-6'].stop_evidence).toBe('parent_taskstop; subagent_interrupt');
    expect(byId['tz-7'].stop_evidence).toBe('killed_notification; subagent_interrupt');
    // the TSV has no assistant-text column and never carries the assistant text
    const tsvW1 = readFileSync(join(dir, 'w1.tsv'), 'utf8').replace(/\n$/, '').split('\n');
    expect(tsvW1.length).toBe(7); // header + 6 rows (5 stopped + 1 empty)
    expect(tsvW1[0].split('\t').length).toBe(8);
    expect(readFileSync(join(dir, 'w1.tsv'), 'utf8')).not.toContain('I stopped this agent');
    expect(w1.stdout).toMatch(/TSV: .* \(6 rows: 1 empty, 5 stopped\)/);
    const header3 = tsvW1[0].split('\t');
    const rowTz1 = tsvW1.slice(1).map((l) => l.split('\t')).find((p) => p[header3.indexOf('id')] === 'tz-1')!;
    expect(rowTz1[header3.indexOf('stop_source')]).toBe('parent_taskstop');
    expect(rowTz1[header3.indexOf('stop_evidence')]).toBe('parent_taskstop x2; killed_notification');

    // ===== run with --intent =====
    const intentFile = join(dir, 'intent.tsv');
    writeFileSync(intentFile, ['id\tintent',
      'tz-1\tintentional', 'tz-2\tother', 'tz-3\tintentional', 'tz-6\tother', 'tz-7\tintentional',
    ].join('\n') + '\n');
    const w2 = run(['--transcripts', dir, '--intent', intentFile, '--json', join(dir, 'w2.json')]);
    expect(w2.status, w2.stderr).toBe(0);
    const r2 = readJson(join(dir, 'w2.json'));
    expect(r2.part_transcripts.intent).toEqual({
      description: 'intentional and other: not measured automatically, read by hand (intent column)',
      file: intentFile,
      intentional: 3,
      other: 2,
      unclassified: 0,
      bad_values: 0,
      unknown_ids: 0,
      duplicate_ids: 0,
    });
    expect(w2.stdout).toMatch(/intentional: 3\/5, other: 2\/5/);
    expect(w2.stdout).toMatch(/unknown ids: 0, duplicate ids: 0/);
    expect(r2.part_transcripts.tsv_rows.map((x: Json) => x.intent)).toEqual(['intentional', 'other', 'intentional', '', 'other', 'intentional']);

    // ===== an --intent file with a bad value =====
    const badFile = join(dir, 'intent-bad.tsv');
    writeFileSync(badFile, 'id\tintent\ntz-1\tunknown\ntz-3\tintentional\n');
    const w3 = run(['--transcripts', dir, '--intent', badFile, '--json', join(dir, 'w3.json')]);
    expect(w3.status, w3.stderr).toBe(0);
    const r3 = readJson(join(dir, 'w3.json'));
    expect(r3.part_transcripts.intent.bad_values).toBe(1);
    expect(r3.part_transcripts.intent.intentional).toBe(1); // only tz-3
    expect(r3.part_transcripts.intent.unclassified).toBe(4);

    // ===== an --intent file with an unknown id and a duplicate =====
    const dupFile = join(dir, 'intent-unknown-duplicates.tsv');
    writeFileSync(dupFile, ['id\tintent',
      'tz-99\tintentional', // an id outside the stopped ones: unknown_ids
      'tz-2\tother',
      'tz-2\tintentional', // a repeated id: the first row counts (other), the second is a duplicate
      'tz-3\tintentional',
    ].join('\n') + '\n');
    const w6 = run(['--transcripts', dir, '--intent', dupFile, '--json', join(dir, 'w6.json')]);
    expect(w6.status, w6.stderr).toBe(0);
    const r6 = readJson(join(dir, 'w6.json'));
    expect(r6.part_transcripts.intent).toEqual({
      description: 'intentional and other: not measured automatically, read by hand (intent column)',
      file: dupFile,
      intentional: 1, // only tz-3 (tz-2 stays with the first row: other)
      other: 1, // only tz-2
      unclassified: 3, // tz-1, tz-6, tz-7
      bad_values: 0,
      unknown_ids: 1, // tz-99
      duplicate_ids: 1, // the second tz-2 row
    });
    expect(w6.stdout).toMatch(/intentional: 1\/2, other: 1\/2/);
    expect(w6.stdout).toMatch(/unknown ids: 1, duplicate ids: 1/);
    expect(r6.part_transcripts.tsv_rows.find((x: Json) => x.id === 'tz-2').intent).toBe('other');

    // ===== exit code 2 for --intent =====
    const w4 = run(['--transcripts', dir, '--intent', join(dir, 'no-such.tsv')]);
    expect(w4.status).toBe(2);
    expect(w4.stderr).toMatch(/is not a file/);
    const noColumns = join(dir, 'intent-no-columns.tsv');
    writeFileSync(noColumns, 'identifier\tvalue\ntz-1\tintentional\n');
    const w5 = run(['--transcripts', dir, '--intent', noColumns]);
    expect(w5.status).toBe(2);
    expect(w5.stderr).toMatch(/missing columns: id, intent/);
  });
});
