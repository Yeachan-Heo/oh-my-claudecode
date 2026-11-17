import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Tests for tools/diagnostics/tool_call_repeats.py on a synthetic fixture (temp directory only, no network).
// The script needs python3; the suite is skipped when python3 is not installed.
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'diagnostics', 'tool_call_repeats.py');
const hasPython3 = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;
if (!hasPython3) console.warn('tool_call_repeats.py tests are skipped: python3 is not available');

const D = '2026-11-14';
const MARKER_PROMPT = 'DUPLICATE-PROMPT-MARKER';
const MARKER_GREP = 'GREP-PATTERN-MARKER';

// Independent Wilson implementation (checked against fixed vectors below).
function wilsonJS(k: number, n: number, z: number): [number, number] | null {
  if (n === 0) return null;
  const p = k / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

const assistant = (ts: string, tool: string, input: unknown, id: string) => JSON.stringify({
  type: 'assistant',
  timestamp: `${D}T${ts}:00.000Z`,
  message: { id: `msg-${id}`, model: 'claude-sonnet-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: tool, input }] },
}) + '\n';
const userResult = (ts: string, toolUseId: string, content: unknown, isError = false) => JSON.stringify({
  type: 'user',
  timestamp: `${D}T${ts}:00.000Z`,
  message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] },
}) + '\n';

/** Call and result builder; timestamps advance one minute per row from the start minute. */
function builder(startMinute = 0) {
  let minute = startMinute;
  let number = 0;
  const clock = (m: number) => `${String(10 + Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return {
    call: (tool: string, input: unknown) => {
      const id = `t${String((number += 1)).padStart(3, '0')}`;
      const ts = clock(minute);
      minute += 1;
      return { row: assistant(ts, tool, input, id), id };
    },
    result: (toolUseId: string, content: unknown, isError = false) => {
      const ts = clock(minute);
      minute += 1;
      return userResult(ts, toolUseId, content, isError);
    },
  };
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe.skipIf(!hasPython3)('tool_call_repeats.py', () => {
  let base: string;
  let transcripts: string;
  let tsvPath: string;
  let jsonPath: string;

  const run = (extra: string[] = [], dir = transcripts) =>
    spawnSync('python3', ['-I', SCRIPT, '--transcripts', dir, ...extra], { encoding: 'utf8' });
  const runJson = (extra: string[], name: string, dir = transcripts): { r: ReturnType<typeof run>; out: Json } => {
    const file = join(base, name);
    const r = run([...extra, '--json', file], dir);
    return { r, out: r.status === 0 ? JSON.parse(readFileSync(file, 'utf8')) : {} };
  };
  const tsvRows = (text: string): Array<Record<string, string>> => {
    const lines = text.trimEnd().split('\n');
    const columns = lines[0].split('\t');
    return lines.slice(1).map((l) => Object.fromEntries(columns.map((c, i) => [c, l.split('\t')[i] ?? ''])));
  };

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'tool-call-repeats-'));
    transcripts = join(base, 'transcripts');
    tsvPath = join(base, 'result.tsv');
    jsonPath = join(base, 'result.json');
    mkdirSync(join(transcripts, 'proj', 'ses-main', 'subagents'), { recursive: true });
    mkdirSync(join(transcripts, 'proj', 'ses-strict'), { recursive: true });

    const t = builder();
    const rows: string[] = [];
    const w = (tool: string, input: unknown, result?: string) => {
      const c = t.call(tool, input);
      rows.push(c.row);
      if (result !== undefined) rows.push(t.result(c.id, result));
      return c;
    };

    // (a): 3 identical Read calls with an identical result
    for (let i = 0; i < 3; i += 1) w('Read', { file_path: '/tmp/x.md' }, 'shared-result');
    // not (a): 3 identical Read calls with different results
    for (let i = 1; i <= 3; i += 1) w('Read', { file_path: '/tmp/x.md' }, `version-${i}`);
    // polling (Bash command, sleep as a whole word): 3x sleep 30
    for (let i = 0; i < 3; i += 1) w('Bash', { command: 'sleep 30' }, 'ok');
    // (a) on Bash: 3x ls (without --poll-prefix ls)
    for (let i = 0; i < 3; i += 1) w('Bash', { command: 'ls -la /tmp/project' }, 'files');
    // (b) result not received: two Agent calls with the same prompt before the first result
    w('Agent', { subagent_type: 'executor', prompt: MARKER_PROMPT, description: 'task one' });
    w('Agent', { subagent_type: 'executor', prompt: MARKER_PROMPT, description: 'task one' });
    // (b) after a result: Agent, result received, then the same prompt again (separate class)
    w('Agent', { subagent_type: 'executor', prompt: `${MARKER_PROMPT}-2`, description: 'task two' }, 'agent-result');
    w('Agent', { subagent_type: 'executor', prompt: `${MARKER_PROMPT}-2`, description: 'task two' });
    // (b): 4 identical prompts: 6 pairs, 3 duplicate calls (the 2nd, 3rd and 4th)
    for (let i = 0; i < 4; i += 1) {
      w('Agent', { subagent_type: 'executor', prompt: `${MARKER_PROMPT}-3`, description: 'task three' });
    }
    // (c): a series of 5 near-identical Grep calls, then a completely different Grep (series boundary)
    for (let i = 1; i <= 5; i += 1) w('Grep', { pattern: `${MARKER_GREP}-part-${i}`, path: '/tmp/searched', output_mode: 'content' }, 'hits');
    w('Grep', { pattern: 'completely-different-search-pattern', path: '/tmp/other', output_mode: 'json' }, 'empty');
    // (d): cycle A,B,A,B,A,B (different results, so not (a))
    const inputA = { file_path: '/tmp/cycle.md' };
    const inputB = { pattern: 'cycle-pattern', path: '/tmp/cycle', output_mode: 'content' };
    for (let i = 1; i <= 3; i += 1) {
      w('Read', inputA, `a${i}`);
      w('Grep', inputB, `x${i}`);
    }
    // polling with a state tool (list extension): 3 identical ReadNotifications
    for (let i = 0; i < 3; i += 1) w('ReadNotifications', {}, 'nothing-new');
    // a bad JSON row (skipped and counted)
    rows.push('{bad-json-row\n');
    writeFileSync(join(transcripts, 'proj', 'ses-main.jsonl'), rows.join(''));

    // strict variant: Read X, Edit, Read X, Edit, Read X: subsequence 1 run, strict 0
    const s = builder(120);
    const strictRows: string[] = [];
    const sw = (tool: string, input: unknown, result: string) => {
      const c = s.call(tool, input);
      strictRows.push(c.row);
      strictRows.push(s.result(c.id, result));
    };
    for (let i = 0; i < 3; i += 1) {
      sw('Read', { file_path: '/tmp/strict.md' }, 'ok-strict');
      if (i < 2) sw('Edit', { file_path: '/tmp/strict.md', old_string: 'a', new_string: 'b' }, 'ok-edit');
    }
    writeFileSync(join(transcripts, 'proj', 'ses-strict.jsonl'), strictRows.join(''));

    // subagent: own context, 3 identical Read calls with an identical result (a)
    const p = builder(60);
    const subagentRows: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const c = p.call('Read', { file_path: '/tmp/agent-x.md' });
      subagentRows.push(c.row);
      subagentRows.push(p.result(c.id, 'agent-result-shared'));
    }
    writeFileSync(join(transcripts, 'proj', 'ses-main', 'subagents', 'agent-a1.jsonl'), subagentRows.join(''));
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('exits 2 with a usage message when --transcripts is missing', () => {
    const r = spawnSync('python3', ['-I', SCRIPT], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage/);
  });

  it('--help exits 0 and lists the options', () => {
    const r = spawnSync('python3', ['-I', SCRIPT, '--help'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--transcripts');
    expect(r.stdout).toContain('--poll-tool');
  });

  it('the test Wilson implementation matches the fixed vectors', () => {
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;
    expect(near(wilsonJS(22, 22, 1.645)![0], 0.8905)).toBe(true);
    expect(near(wilsonJS(20, 22, 1.645)![0], 0.7591)).toBe(true);
    expect(near(wilsonJS(15, 30, 1.645)![0], 0.3562)).toBe(true);
    expect(near(wilsonJS(10, 10, 1.645)![0], 0.787)).toBe(true);
    expect(near(wilsonJS(22, 22, 1.96)![0], 0.8513) && near(wilsonJS(22, 22, 1.96)![1], 1.0)).toBe(true);
    expect(near(wilsonJS(15, 30, 1.96)![0], 0.3315) && near(wilsonJS(15, 30, 1.96)![1], 0.6685)).toBe(true);
  });

  it('main run: four counts in both variants, duplicate calls, TSV, JSON, no content in the output', () => {
    const r = run(['--tsv', tsvPath, '--json', jsonPath]);
    expect(r.status, r.stderr).toBe(0);
    const out: Json = JSON.parse(readFileSync(jsonPath, 'utf8'));

    // fixture: ses-main 35 calls (Read 9, Bash 6, Agent 8, Grep 9, ReadNotifications 3),
    // ses-strict 5 (Read 3, Edit 2), subagent 3 Read; 43 in total, 3 contexts
    expect(out.stats.contexts).toBe(3);
    expect(out.stats.sessions).toBe(2);
    expect(out.stats.subagents).toBe(1);
    expect(out.stats.calls).toBe(43);
    expect(out.stats.bad_lines, 'bad JSON is skipped and counted').toBe(1);

    expect(out.denominators.by_tool).toEqual({ Read: 15, Bash: 6, Agent: 8, Grep: 9, ReadNotifications: 3, Edit: 2 });

    // (a) both variants; subsequence: Read 3 (ses-main, ses-strict, agent) + Bash ls 1 = 4,
    // strict: Read 2 (ses-main, agent; ses-strict is broken by Edit) + Bash ls 1 = 3
    expect(out.a.subsequence.sequences).toBe(4);
    expect(out.a.subsequence.calls).toBe(12);
    expect(out.a.subsequence.by_tool.Read.sequences).toBe(3);
    expect(out.a.subsequence.by_tool.Bash.sequences).toBe(1);
    expect(out.a.subsequence.by_tool.Edit, 'Edit has only 2 calls: below the threshold 3').toBeUndefined();
    expect(out.a.strict.sequences, 'Edit between the Read calls breaks the strict run').toBe(3);
    expect(out.a.strict.calls).toBe(9);
    expect(out.a.strict.by_tool.Read.sequences).toBe(2);
    expect(out.a.strict.by_tool.Bash.sequences).toBe(1);
    expect(out.a.strict.by_tool.Edit).toBeUndefined();
    expect(out.a.contexts_with_run).toEqual({ subsequence: 3, strict: 2 });
    expect(out.a.contexts_total).toBe(3);
    // polling with state tools is not (a); the ReadNotifications run would return to (a) without the state tools
    expect(out.a.subsequence.state_tools).toEqual({ sequences: 1, calls: 3 });
    expect(out.a.strict.state_tools).toEqual({ sequences: 1, calls: 3 });
    expect(out.a.without_state_tools.subsequence).toEqual({ sequences: 5, calls: 15 });
    expect(out.a.without_state_tools.strict).toEqual({ sequences: 4, calls: 12 });

    // (b): 8 pairs (7 with the result not received, 1 after a result), 5 duplicate calls (each call once)
    expect(out.b.pairs_no_result).toBe(7);
    expect(out.b.pairs_after_result).toBe(1);
    expect(out.b.pairs).toBe(8);
    expect(out.b.duplicate_calls).toBe(5);
    expect(out.b.denominator.Agent).toBe(8);
    expect(out.b.pairs_by_tool).toEqual({ Agent: 8 });
    expect(out.b.duplicates_by_tool).toEqual({ Agent: 5 });
    expect(out.b.agent_without_prompt).toBe(0);

    // (c): the Grep series in both variants
    expect(out.c.subsequence.series).toBe(1);
    expect(out.c.subsequence.calls).toBe(5);
    expect(out.c.strict.series).toBe(1);
    expect(out.c.strict.calls).toBe(5);
    expect(out.c.subsequence.by_tool.Grep.calls).toBe(5);

    // (d): cycle A,B,A,B,A,B
    expect(out.d.cycles).toBe(1);
    expect(out.d.calls).toBe(6);
    expect(out.d.by_period).toEqual({ '2': 1 });
    expect(out.d.by_tools).toEqual({ 'Read,Grep': 1 });

    // polling: sleep (Bash) + ReadNotifications (state tool), 2 runs / 6 calls in both variants
    expect(out.polling.subsequence.sequences).toBe(2);
    expect(out.polling.subsequence.calls).toBe(6);
    expect(out.polling.strict.sequences).toBe(2);
    expect(out.polling.strict.calls).toBe(6);
    expect(out.polling.matched_calls).toEqual({ Bash: 3, ReadNotifications: 3 });
    expect(out.polling.matched_calls_total).toBe(6);

    // two repeat-work sums, each for both variants
    expect(out.repeat_work_sum.subsequence).toEqual({ strict_sum: 13, with_b_after_result: 14 });
    expect(out.repeat_work_sum.strict).toEqual({ strict_sum: 12, with_b_after_result: 13 });

    // rates: (b) from duplicate calls 5/8; Wilson from the independent implementation
    const rateB = out.rate_table['b:Agent'];
    expect(rateB.k).toBe(5);
    expect(rateB.n).toBe(8);
    expect((rateB.wilson_1_96 as number[]).map(r6)).toEqual(wilsonJS(5, 8, 1.96)!.map(r6));
    expect(Math.abs(rateB.wilson_lower_1_645 - wilsonJS(5, 8, 1.645)![0])).toBeLessThan(1e-9);
    const rateA = out.rate_table['a_subsequence:Read'];
    expect(rateA.k).toBe(9);
    expect(rateA.n).toBe(15);
    expect((rateA.wilson_1_96 as number[]).map(r6)).toEqual(wilsonJS(9, 15, 1.96)!.map(r6));
    expect(out.rate_table['a_strict:Read'].k).toBe(6);
    expect(out.rate_table['a_strict:Read'].n).toBe(15);
    expect(out.rate_table['c_subsequence:Grep'].k).toBe(5);
    expect(out.rate_table['c_strict:Grep'].k).toBe(5);
    expect(out.rate_table['polling_subsequence:Bash'].k).toBe(3);
    expect(out.rate_table['polling_subsequence:Bash'].n).toBe(6);
    expect(out.rate_table['polling_subsequence:ReadNotifications'].n).toBe(3);
    expect(out.rate_table['polling_subsequence:ReadNotifications'].threshold_status).toBe('no threshold (too little data)');

    // report: variants, matched calls, two sums
    expect(r.stdout).toMatch(/Variant subsequence/);
    expect(r.stdout).toMatch(/Variant strict/);
    expect(r.stdout).toMatch(/matched calls total 6/);
    expect(r.stdout).toMatch(/repeat-work sum, Variant subsequence: strict: \(a\)\+\(b before result\)\+\(c\)\+\(d\) = 4\+7\+1\+1 = 13 \(strict sum\)/);
    expect(r.stdout).toMatch(/with \(b\) after result = 4\+8\+1\+1 = 14/);
    expect(r.stdout).toMatch(/repeat-work sum, Variant strict: strict:.*= 3\+7\+1\+1 = 12 \(strict sum\)/);
    expect(r.stdout).toMatch(/ReadNotifications/);
    expect(r.stdout).toMatch(/threshold defaults are starting values to tune with data/);

    // TSV: header with the variant; 22 rows: 4 a subsequence + 3 a strict + 2 polling subsequence
    // + 2 polling strict + 8 b + 1 c subsequence + 1 c strict + 1 d
    const tsvText = readFileSync(tsvPath, 'utf8');
    expect(tsvText.trimEnd().split('\n')[0]).toBe('kind\tvariant\tcontext\ttool\tfrom_ts\tto_ts\tcalls\tperiod\tsignature');
    const rows = tsvRows(tsvText);
    expect(rows.length).toBe(22);
    const by = (kind: string, variant?: string) => rows.filter((x) => x.kind === kind && (variant === undefined || x.variant === variant));
    expect(by('a', 'subsequence').length).toBe(4);
    expect(by('a', 'strict').length).toBe(3);
    expect(by('polling', 'subsequence').length).toBe(2);
    expect(by('polling', 'strict').length).toBe(2);
    expect(by('b').length, 'pairs with the result not received').toBe(7);
    expect(by('b', '').length, 'empty variant for b').toBe(7);
    expect(by('b_after_result').length).toBe(1);
    expect(by('c', 'subsequence').length).toBe(1);
    expect(by('c', 'strict').length).toBe(1);
    expect(by('d').length).toBe(1);
    expect(by('d', '').length).toBe(1);
    expect(rows.filter((x) => x.kind === 'a' || x.kind === 'c' || x.kind === 'polling')
      .every((x) => x.variant === 'strict' || x.variant === 'subsequence'), 'variant strict or subsequence for a, c, polling').toBe(true);
    const cycleRow = by('d')[0];
    expect(cycleRow.period).toBe('2');
    expect(cycleRow.calls).toBe('6');
    expect(cycleRow.tool).toBe('Read,Grep');
    expect(rows.every((x) => x.signature.length === 12), 'the signature is a 12-char digest').toBe(true);
    expect(by('b')[0].calls).toBe('2');
    expect(rows.some((x) => x.context === 'session:ses-main')).toBe(true);
    expect(rows.some((x) => x.context === 'session:ses-strict')).toBe(true);
    expect(rows.some((x) => x.context === 'agent:ses-main/a1')).toBe(true);

    // no input, prompt or result content in any output
    const everything = r.stdout + tsvText + readFileSync(jsonPath, 'utf8');
    expect(everything).not.toContain(MARKER_PROMPT);
    expect(everything).not.toContain(MARKER_GREP);
    expect(everything).not.toContain('shared-result');
    expect(everything).not.toContain('completely-different-search-pattern');
    expect(everything).not.toContain('agent-result');
  });

  it('Agent without a prompt stays out of (b), sleep is a whole word, --poll-tool and an MCP suffix work', () => {
    const dir = join(base, 'poll-extension');
    mkdirSync(join(dir, 'tr', 'proj'), { recursive: true });
    const t = builder(180);
    const rows: string[] = [];
    const w = (tool: string, input: unknown, result?: string) => {
      const c = t.call(tool, input);
      rows.push(c.row);
      if (result !== undefined) rows.push(t.result(c.id, result));
    };
    for (let i = 0; i < 2; i += 1) w('Bash', { command: 'sleep 5' }, 'ok');
    w('Bash', { command: 'sleep' }, 'ok');
    for (let i = 0; i < 3; i += 1) w('Bash', { command: 'sleeper-x --flag' }, 'ok');
    for (let i = 0; i < 3; i += 1) w('MyState', {}, 'state');
    for (let i = 0; i < 2; i += 1) w('mcp__service__state_read', { key: 'x' }, 'value');
    w('Agent', { subagent_type: 'executor' });
    w('Agent', { subagent_type: 'executor' });
    writeFileSync(join(dir, 'tr', 'proj', 'ses-poll.jsonl'), rows.join(''));
    const tr = join(dir, 'tr');

    // without the option: sleep (3 calls, 2 different signatures) matched, 0 runs;
    // sleeper-x is not polling (whole word), MyState is not matched, the __state_read suffix is
    const first = runJson([], 'poll-a.json', tr);
    expect(first.r.status, first.r.stderr).toBe(0);
    const w1 = first.out;
    expect(w1.polling.matched_calls.Bash, 'sleep and sleep 5 matched, sleeper-x not').toBe(3);
    expect(w1.polling.matched_calls_total, 'Bash 3 + mcp__service__state_read 2').toBe(5);
    expect(w1.polling.matched_calls['mcp__service__state_read'], 'MCP suffix __state_read').toBe(2);
    expect(w1.polling.subsequence.sequences, 'sleep has 2 different signatures; the MCP run is short').toBe(0);
    expect(w1.a.subsequence.sequences, 'sleeper-x 1 + MyState 1 (mcp has 2 calls, below the threshold)').toBe(2);
    expect(w1.a.strict.sequences).toBe(2);
    expect(w1.b.pairs, 'Agent without a prompt makes no pairs').toBe(0);
    expect(w1.b.denominator.Agent ?? 0, 'Agent without a prompt stays out of the (b) denominator').toBe(0);
    expect(w1.b.agent_without_prompt, 'Agent without a prompt is counted separately').toBe(2);
    expect(w1.repeat_work_sum.subsequence).toEqual({ strict_sum: 2, with_b_after_result: 2 });

    // with --poll-tool MyState: MyState moves from (a) to polling
    const second = runJson(['--poll-tool', 'MyState'], 'poll-b.json', tr);
    expect(second.r.status, second.r.stderr).toBe(0);
    const w2 = second.out;
    expect(w2.a.subsequence.sequences, 'only sleeper-x').toBe(1);
    expect(w2.polling.subsequence.sequences, 'MyState in the polling category').toBe(1);
    expect(w2.polling.matched_calls.MyState).toBe(3);
    expect(w2.polling.matched_calls_total).toBe(8);
    expect(w2.repeat_work_sum.subsequence).toEqual({ strict_sum: 1, with_b_after_result: 1 });
  });

  it('--poll-prefix extends the exception: ls moves from (a) to polling', () => {
    const { r, out } = runJson(['--poll-prefix', 'ls'], 'poll-prefix.json');
    expect(r.status, r.stderr).toBe(0);
    expect(out.a.subsequence.sequences, '(a) subsequence without ls: Read 3').toBe(3);
    expect(out.a.strict.sequences, '(a) strict without ls: Read 2 (ses-main and agent)').toBe(2);
    expect(out.polling.subsequence.sequences, 'sleep + ls + ReadNotifications').toBe(3);
    expect(out.polling.strict.sequences).toBe(3);
    expect(out.polling.matched_calls.Bash, 'sleep 3 + ls 3').toBe(6);
    expect(out.repeat_work_sum.subsequence).toEqual({ strict_sum: 12, with_b_after_result: 13 });
    expect(out.repeat_work_sum.strict).toEqual({ strict_sum: 11, with_b_after_result: 12 });
  });

  it('the thresholds work: --min-identical 4 and --min-similar 6 switch the detections off', () => {
    const { r, out } = runJson(['--min-identical', '4', '--min-similar', '6'], 'thresholds.json');
    expect(r.status, r.stderr).toBe(0);
    expect(out.a.subsequence.sequences).toBe(0);
    expect(out.a.strict.sequences).toBe(0);
    expect(out.c.subsequence.series).toBe(0);
    expect(out.c.strict.series).toBe(0);
    expect(out.polling.subsequence.sequences).toBe(0);
    expect(out.b.pairs, 'the (b) pairs do not depend on the run thresholds').toBe(8);
    expect(out.repeat_work_sum.subsequence).toEqual({ strict_sum: 8, with_b_after_result: 9 });
    expect(out.repeat_work_sum.strict).toEqual({ strict_sum: 8, with_b_after_result: 9 });
    expect(r.stdout).toMatch(/repeat-work sum, Variant subsequence: strict:.*= 0\+7\+0\+1 = 8 \(strict sum\)/);
  });

  it('the --to filter cuts calls outside the range (denominators drop)', () => {
    const { r, out } = runJson(['--to', `${D}T10:23:00Z`], 'range.json');
    expect(r.status, r.stderr).toBe(0);
    // up to 10:23 (a call every 2 minutes from 10:00): Read 6 (10:00-10:10), sleep 3 (10:12-16), ls 3 (10:18-22)
    expect(out.stats.calls).toBe(12);
    expect(out.denominators.by_tool.Read).toBe(6);
    expect(out.denominators.by_tool.Agent).toBeUndefined();
    expect(out.a.contexts_total, 'the subagent (11:00+) and ses-strict (12:00+) are outside the range').toBe(1);
    expect(out.a.subsequence.sequences, 'Read + ls').toBe(2);
    expect(out.a.strict.sequences).toBe(2);
    expect(out.b.pairs, 'Agent is outside the range').toBe(0);
    expect(out.repeat_work_sum.subsequence).toEqual({ strict_sum: 2, with_b_after_result: 2 });
  });

  it('threshold status: --min-support 5 gives enough data', () => {
    const { r, out } = runJson(['--min-support', '5'], 'support.json');
    expect(r.status, r.stderr).toBe(0);
    expect(out.rate_table['a_subsequence:Read'].threshold_status, 'n = 15 >= 5').toBe('ok');
    expect(out.rate_table['b:Agent'].threshold_status, 'n = 8 >= 5').toBe('ok');
    expect(out.rate_table['a_subsequence:Read'].wilson_lower_1_645).toBeGreaterThan(0);
  });

  it('bad arguments and a bad write path give exit code 2', () => {
    const badPeriods = run(['--periods', '6-2']);
    expect(badPeriods.status).toBe(2);
    expect(badPeriods.stderr).toMatch(/--periods/);
    const badDice = run(['--dice', '1.5']);
    expect(badDice.status).toBe(2);
    expect(badDice.stderr).toMatch(/--dice/);
    expect(run(['--periods', 'abc']).status).toBe(2);
    const badWrite = run(['--tsv', join(base, 'no-such-directory', 'w.tsv')]);
    expect(badWrite.status, 'write guard: exit 2, not a traceback').toBe(2);
    expect(badWrite.stderr).toMatch(/cannot write/);
  });
});

// Edge cases on one-session fixtures (one transcript per case, temp directory only).
describe.skipIf(!hasPython3)('tool_call_repeats.py edge cases', () => {
  /** Writes one session transcript, runs the script on it and returns the JSON result and the TSV rows. */
  function runSession(rows: string[]): { out: Json; findings: Array<Record<string, string>> } {
    const dir = mkdtempSync(join(tmpdir(), 'tool-call-repeats-edge-'));
    try {
      mkdirSync(join(dir, 'proj'), { recursive: true });
      writeFileSync(join(dir, 'proj', 'ses-edge.jsonl'), rows.join(''));
      const jsonFile = join(dir, 'out.json');
      const tsvFile = join(dir, 'out.tsv');
      const r = spawnSync('python3', ['-I', SCRIPT, '--transcripts', dir, '--json', jsonFile, '--tsv', tsvFile], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      const lines = readFileSync(tsvFile, 'utf8').trimEnd().split('\n');
      const columns = lines[0].split('\t');
      const findings = lines.slice(1).filter((l) => l !== '').map((l) => Object.fromEntries(columns.map((c, i) => [c, l.split('\t')[i] ?? ''])));
      return { out: JSON.parse(readFileSync(jsonFile, 'utf8')), findings };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('rows whose message is not an object are skipped without ending the run', () => {
    const t = builder();
    const c = t.call('Read', { file_path: '/tmp/ok.md' });
    const malformed = ['"text"', '7', '[1, 2]'].flatMap((message) => [
      `{"type":"assistant","timestamp":"${D}T09:00:00.000Z","message":${message}}\n`,
      `{"type":"user","timestamp":"${D}T09:00:01.000Z","message":${message}}\n`,
    ]);
    const { out } = runSession([...malformed, c.row, t.result(c.id, 'fine')]);
    expect(out.denominators.by_tool).toEqual({ Read: 1 });
  });

  it('counts replayed copies of one tool call (the same tool-use id) once', () => {
    const t = builder();
    const c = t.call('Read', { file_path: '/tmp/replayed.md' });
    const rows = [c.row, c.row, c.row, t.result(c.id, 'same-result')];
    const { out, findings } = runSession(rows);
    expect(out.denominators.by_tool).toEqual({ Read: 1 });
    expect(out.a.subsequence.sequences).toBe(0);
    expect(out.a.strict.sequences).toBe(0);
    expect(out.repeat_work_sum.strict.strict_sum).toBe(0);
    expect(findings).toEqual([]);
  });

  it('keeps polling-only series and cycles out of the repeat-work sums, and still counts a mixed cycle', () => {
    const polling = builder();
    const rows: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      for (const taskId of ['1', '2']) {
        const c = polling.call('TaskGet', { task_id: taskId });
        rows.push(c.row, polling.result(c.id, `status-${i}`));
      }
    }
    const { out } = runSession(rows);
    expect(out.polling.matched_calls_total).toBe(6);
    expect(out.d.cycles, 'a cycle of polling calls only').toBe(0);
    expect(out.c.strict.series).toBe(0);
    expect(out.c.subsequence.series).toBe(0);
    expect(out.repeat_work_sum.strict.strict_sum).toBe(0);
    expect(out.repeat_work_sum.subsequence.strict_sum).toBe(0);

    // a cycle with one non-polling call in it is real repeat work
    const mixed = builder();
    const mixedRows: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const read = mixed.call('Read', { file_path: '/tmp/mixed.md' });
      const poll = mixed.call('TaskGet', { task_id: '1' });
      mixedRows.push(read.row, mixed.result(read.id, `r${i}`), poll.row, mixed.result(poll.id, `p${i}`));
    }
    expect(runSession(mixedRows).out.d.cycles).toBe(1);
  });

  it('takes the evidence range of a subsequence run from the calls of the run, not from the unfiltered stream', () => {
    const t = builder();
    const rows: string[] = [];
    const sleep = t.call('Bash', { command: 'sleep 30' });
    rows.push(sleep.row, t.result(sleep.id, 'ok'));
    const lsTimes: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const c = t.call('Bash', { command: 'ls -la /tmp/project' });
      lsTimes.push(JSON.parse(c.row).timestamp);
      rows.push(c.row, t.result(c.id, 'files'));
    }
    const { findings } = runSession(rows);
    const run = findings.find((f) => f.kind === 'a' && f.variant === 'subsequence');
    expect(run, 'the three identical ls calls are one run').toBeDefined();
    expect(run!.calls).toBe('3');
    expect(run!.from_ts).toBe(lsTimes[0]);
    expect(run!.to_ts).toBe(lsTimes[2]);
  });
});

