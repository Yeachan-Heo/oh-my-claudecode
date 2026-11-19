import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Tests for tools/diagnostics/decision_outcome_join.py on a synthetic fixture (temp directory only, no network).
// The script needs python3; the suite is skipped when python3 is not installed.
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'diagnostics', 'decision_outcome_join.py');
const hasPython3 = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;
if (!hasPython3) console.warn('decision_outcome_join.py tests are skipped: python3 is not available');

const MARKER = 'UNIQUE-MARKER-TASK-TEXT';

// Price table of the fixture (USD per 1 million tokens: input, cache write 5 min, cache write 1 h, cache read, output).
const PRICES = {
  haiku: [0.1, 0.125, 0.2, 0.01, 0.5],
  'haiku>100k': [0.5, 0.625, 1.0, 0.05, 2.5],
  sonnet: [2.0, 2.5, 4.0, 0.1, 10.0],
  opus: [4.0, 5.0, 8.0, 0.2, 20.0],
  'fable-5-1': [10.0, 12.5, 20.0, 0.25, 50.0],
  'fable-5-2': [8.0, 10.0, 16.0, 0.2, 40.0],
};

let base: string;
let journal: string;
let transcripts: string;
let tsvPath: string;
let jsonPath: string;
let prices: string;

const usage = (inp: number, z5: number, z1h: number, cacheRead: number, out: number, thinking = 0) => ({
  input_tokens: inp,
  cache_creation_input_tokens: z5 + z1h,
  cache_creation: { ephemeral_5m_input_tokens: z5, ephemeral_1h_input_tokens: z1h },
  cache_read_input_tokens: cacheRead,
  output_tokens: out,
  output_tokens_details: { thinking_tokens: thinking },
});

const assistant = (id: string, model: string, options: { stop?: string; content?: unknown[]; usage?: unknown; isError?: boolean } = {}) => JSON.stringify({
  type: 'assistant',
  message: {
    id: `msg-${id}`,
    model,
    stop_reason: options.stop ?? 'end_turn',
    content: options.content ?? [{ type: 'text', text: 'ok' }],
    ...(options.usage ? { usage: options.usage } : {}),
  },
  ...(options.isError ? { is_error: true } : {}),
}) + '\n';

const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

// The row has the shape the routing hook writes: the subagent type is inside the applied object.
const applied = (ts: string, session: string, subagentType: string, modelFrom: string | null, modelTo: string | null, effortFrom: string | null, effortTo: string | null, extra: Record<string, unknown> = {}) => JSON.stringify({
  ts,
  point: 'model-routing',
  tool_use_id: extra.toolUseId ?? undefined,
  session_id: session,
  applied: {
    subagent_type: subagentType,
    model: { from: modelFrom, to: modelTo, source: extra.source ?? 'jev' },
    effort: { from: effortFrom, to: effortTo, source: extra.source ?? 'jev' },
  },
  ...(extra.marker ? { marker: extra.marker } : {}),
}) + '\n';

/** Applied row with a time stamp derived from the tool use id length (as in the original fixture). */
const row = (toolUseId: string, session: string, subagentType: string, modelFrom: string | null, modelTo: string | null, effortFrom: string | null, effortTo: string | null, extra: Record<string, unknown> = {}) =>
  applied(`2026-11-14T09:${String(10 + (toolUseId.length % 9)).padStart(2, '0')}:00.000Z`, session, subagentType, modelFrom, modelTo, effortFrom, effortTo, { toolUseId, ...extra });

const meta = (toolUseId: string, agentId: string, model: string, effort: string) => JSON.stringify({ toolUseId, model, effort, agentId, name: 'executor' }) + '\n';

function run(extra: string[] = []) {
  return spawnSync('python3', ['-I', SCRIPT, '--journal', journal, '--transcripts', transcripts, '--prices', prices, ...extra], { encoding: 'utf8' });
}

beforeAll(() => {
  if (!hasPython3) return;
  base = mkdtempSync(join(tmpdir(), 'decision-outcome-join-test-'));
  journal = join(base, 'journal');
  transcripts = join(base, 'transcripts');
  tsvPath = join(base, 'result.tsv');
  jsonPath = join(base, 'result.json');
  prices = join(base, 'prices.json');
  writeFileSync(prices, JSON.stringify(PRICES));
  tsvPath = join(base, 'result.tsv');

  // applied.jsonl: A1, A2, A3, A5 (no meta), A6 (0 turns), A7 (duplicate tid-1), A8 (no tool_use_id), A9 (no transcript)
  write(join(journal, 'applied.jsonl'),
    row('tid-1', 'ses-1', 'executor', null, 'haiku', null, 'low')
    + row('tid-2', 'ses-2', 'reviewer-checks', 'opus', 'sonnet', null, 'high', { source: 'marker', marker: 'use opus high' })
    + row('tid-3', 'ses-3', 'advisor-agent', 'sonnet', 'opus', 'high', 'max')
    + row('tid-5', 's5', 'executor', null, 'haiku', null, 'low')
    + row('tid-6', 'ses-6', 'executor', null, 'haiku', null, 'low')
    + row('tid-1', 'ses-1', 'executor', null, 'haiku', null, 'low')
    + row('tid-9', 'ses-9', 'executor', null, 'fable-5-2', null, 'max')
    // A8: no tool_use_id
    + JSON.stringify({ ts: '2026-11-14T09:50:00.000Z', point: 'model-routing', subagent_type: 'executor', applied: {} }) + '\n');

  // A4: only in a rotated applied file
  write(join(journal, 'applied-20261114-080000.jsonl'),
    row('tid-4', 'ses-4', 'executor', null, 'haiku', null, 'xhigh', { source: 'heuristic' }));

  // shadow.jsonl: a degraded row, A1 (pointer prompt) and A3 (full prompt)
  write(join(journal, 'shadow.jsonl'),
    JSON.stringify({ ts: '2026-11-14T08:55:00.000Z', point: 'model-routing', mode: 'degraded' }) + '\n'
    + JSON.stringify({
      ts: '2026-11-14T09:01:00.000Z', point: 'model-routing', mode: 'active', tool_use_id: 'tid-1',
      state: { task: `Read ${MARKER} and execute /tmp/brief.md` },
      answers: {
        'model-tier': { choice: 'haiku', probabilities: { haiku: 0.9, sonnet: 0.1 }, confidence: 0.9 },
        effort: { choice: 'low', probabilities: { low: 0.85, medium: 0.15 }, confidence: 0.8 },
      },
    }) + '\n'
    + JSON.stringify({
      ts: '2026-11-14T09:03:00.000Z', point: 'model-routing', mode: 'active', tool_use_id: 'tid-3',
      state: { task: 'x'.repeat(700) },
      answers: {
        'model-tier': { choice: 'opus', probabilities: { opus: 0.45, sonnet: 0.4, haiku: 0.15 }, confidence: 0.5 },
        effort: { choice: 'max', probabilities: { max: 0.7, high: 3.2 - 2.9 }, confidence: 0.6 },
      },
    }) + '\n');

  // shadow-rotated.jsonl (rotated file of the shadow journal): A4
  write(join(journal, 'shadow-20261114-080000.jsonl'),
    JSON.stringify({
      ts: '2026-11-14T08:05:00.000Z', point: 'model-routing', mode: 'active', tool_use_id: 'tid-4',
      state: { task: 'Read /tmp/task.md' },
      answers: {
        'model-tier': { choice: 'haiku', probabilities: { haiku: 0.8, sonnet: 0.2 }, confidence: 0.6 },
        effort: { choice: 'xhigh', probabilities: { xhigh: 0.6, low: 0.4 }, confidence: 0.55 },
      },
    }) + '\n');

  // ===== meta and transcripts of Claude agents =====
  write(join(transcripts, 'project-p', 'ses-1', 'subagents', 'agent-a1.meta.json'), meta('tid-1', 'a1', 'haiku', 'low'));
  write(join(transcripts, 'project-p', 'ses-1', 'subagents', 'agent-a1.jsonl'),
    assistant('1a', 'claude-haiku-5-5', { usage: usage(1000, 200, 0, 300, 50, 10) })
    + assistant('1b', 'claude-haiku-5-5', { usage: usage(1000, 200, 0, 326 - 26, 50, 10) })
    + assistant('1c', 'claude-haiku-5-5', { stop: 'tool_use', usage: usage(100, 0, 0, 0, 10), content: [{ type: 'tool_use', tool_use_id: 't-1', name: 'Bash', input: {} }] }));
  write(join(transcripts, 'project-p', 'ses-2', 'subagents', 'agent-a2.meta.json'), meta('tid-2', 'a2', 'sonnet', 'high'));
  write(join(transcripts, 'project-p', 'ses-2', 'subagents', 'agent-a2.jsonl'),
    assistant('2a', 'claude-sonnet-5-5', { usage: usage(200000, 0, 0, 5000, 100), isError: true }));
  write(join(transcripts, 'project-p', 'ses-3', 'subagents', 'agent-a3.meta.json'), meta('tid-3', 'a3', 'opus', 'max'));
  write(join(transcripts, 'project-p', 'ses-3', 'subagents', 'agent-a3.jsonl'),
    assistant('3a', 'claude-sonnet-5-5', { usage: usage(1000, 200, 0, 300, 50) })
    + assistant('3b', 'claude-sonnet-5-5', { usage: usage(1000, 200, 0, 300, 50) })
    + assistant('3c', 'other-model-9', { usage: usage(500, 0, 0, 0, 30), content: [{ type: 'thinking', thinking: 'r'.repeat(55) }, { type: 'text', text: 'ok' }] }));
  write(join(transcripts, 'project-p', 'ses-4', 'subagents', 'child', 'agent-a4.meta.json'), meta('tid-4', 'a4', 'haiku', 'xhigh'));
  write(join(transcripts, 'project-p', 'ses-4', 'subagents', 'child', 'agent-a4.jsonl'), assistant('4a', 'claude-haiku-5-5', { usage: usage(100, 0, 0, 0, 10) }));
  write(join(transcripts, 'project-p', 'ses-6', 'subagents', 'agent-a6.meta.json'), meta('tid-6', 'a6', 'haiku', 'low'));
  write(join(transcripts, 'project-p', 'ses-6', 'subagents', 'agent-a6.jsonl'), JSON.stringify({ type: 'user', message: { content: 'x' } }) + '\n');
  write(join(transcripts, 'project-p', 'ses-9', 'subagents', 'agent-a9.meta.json'), meta('tid-9', 'a9', 'fable-5-2', 'max'));

  // A10: applied with an effort only, no model field
  appendFileSync(join(journal, 'applied.jsonl'),
    JSON.stringify({ ts: '2026-11-14T09:52:00.000Z', point: 'model-routing', tool_use_id: 'tid-10',
      session_id: 'ses-10', subagent_type: 'executor',
      applied: { effort: { from: null, to: 'low', source: 'marker' } } }) + '\n');
  write(join(transcripts, 'project-p', 'ses-10', 'subagents', 'agent-a10.meta.json'), meta('tid-10', 'a10', 'haiku', 'low'));
  write(join(transcripts, 'project-p', 'ses-10', 'subagents', 'agent-a10.jsonl'), assistant('10a', 'claude-haiku-5-5', { usage: usage(1000, 200, 0, 300, 50) }));

  // A11: a row with an unreadable ts
  appendFileSync(join(journal, 'applied.jsonl'),
    JSON.stringify({ ts: 'not-a-date', point: 'model-routing', tool_use_id: 'tid-11',
      session_id: 'ses-11', subagent_type: 'executor',
      applied: { model: { from: null, to: 'haiku', source: 'jev' } } }) + '\n');

  // A12: subagent_type only at the top level of the row (the fallback for rows without it in the applied object)
  appendFileSync(join(journal, 'applied.jsonl'),
    JSON.stringify({ ts: '2026-11-14T09:54:00.000Z', point: 'model-routing', tool_use_id: 'tid-12',
      session_id: 'ses-12', subagent_type: 'custom-executor',
      applied: { model: { from: null, to: 'haiku', source: 'jev' } } }) + '\n');
  write(join(transcripts, 'project-p', 'ses-12', 'subagents', 'agent-a12.meta.json'), meta('tid-12', 'a12', 'haiku', 'low'));
  write(join(transcripts, 'project-p', 'ses-12', 'subagents', 'agent-a12.jsonl'), assistant('12a', 'claude-haiku-5-5', { usage: usage(1000, 200, 0, 300, 50) }));
});

afterAll(() => {
  if (hasPython3) rmSync(base, { recursive: true, force: true });
});

describe.skipIf(!hasPython3)('decision_outcome_join', () => {
  it('exit code 2 without arguments, with a usage message', () => {
    const result = spawnSync('python3', ['-I', SCRIPT], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/usage/);
  });

  it('Wilson vectors shared with wilson_threshold.mjs (tolerance 1e-4)', () => {
    const result = spawnSync('python3', ['-I', SCRIPT, '--wilson-vectors'], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const v = JSON.parse(result.stdout);
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;
    expect(near(v['22/22'].z_1_645_lower, 0.8905)).toBe(true);
    expect(near(v['20/22'].z_1_645_lower, 0.7591)).toBe(true);
    expect(near(v['18/22'].z_1_645_lower, 0.651)).toBe(true);
    expect(near(v['10/10'].z_1_645_lower, 0.787)).toBe(true);
    expect(near(v['245/245'].z_1_645_lower, 0.9891)).toBe(true);
    expect(near(v['15/30'].z_1_645_lower, 0.3562)).toBe(true);
    expect(near(v['941/1019'].z_1_645_lower, 0.9086)).toBe(true);
    expect(near(v['0/30'].z_1_645_lower, 0.0)).toBe(true);
    expect(near(v['22/22'].z_1_96[0], 0.8513) && near(v['22/22'].z_1_96[1], 1.0)).toBe(true);
    expect(near(v['20/22'].z_1_96[0], 0.7218) && near(v['20/22'].z_1_96[1], 0.9747)).toBe(true);
    expect(near(v['15/30'].z_1_96[0], 0.3315) && near(v['15/30'].z_1_96[1], 0.6685)).toBe(true);
    expect(near(v['941/1019'].z_1_96[0], 0.9055) && near(v['941/1019'].z_1_96[1], 0.9382)).toBe(true);
  });

  it('join, agents, margins, price consistency and outputs', () => {
    const result = run(['--tsv', tsvPath, '--json', jsonPath, '--from', '2026-11-14T00:00:00Z', '--to', '2026-11-15T00:00:00Z', '--source-map', 'reviewer=reviewer', '--source-map', 'advisor-agent=advisor', '--source-map', 'custom=custom-source']);
    expect(result.status, result.stderr).toBe(0);
    const out = JSON.parse(readFileSync(jsonPath, 'utf8'));

    // coverage (a): 12 applied model-routing rows in the period, 6 joined to a transcript with turns > 0
    expect(out.join.n).toBe(12);
    expect(out.join.k).toBe(6);
    expect(out.join.distribution.no_tool_use_id).toBe(1);
    expect(out.join.distribution.no_meta).toBe(1);
    expect(out.join.distribution.duplicates).toBe(1);
    expect(out.join.distribution.no_transcript).toBe(1);
    expect(out.join.distribution.zero_turns).toBe(1);
    expect(out.join.distribution.bad_ts).toBe(1);
    expect(out.join.distribution.joined).toBe(6);
    expect(out.join.wilson_1_96[0] > 0 && out.join.wilson_1_96[0] <= out.join.k / out.join.n).toBe(true);
    expect(out.join.wilson_lower_1_645).toBeLessThanOrEqual(out.join.share);

    expect(out.join.model_match).toEqual({ 'no model decision': 1, mismatch: 1, undetermined: 1, match: 4 });

    const byTid: Record<string, Record<string, unknown>> = {};
    for (const a of out.agents) byTid[a.tool_use_id] = a;
    const a1 = byTid['tid-1'];
    expect(a1.model_match).toBe('match');
    expect(a1.cost_status).toBe('reported');
    expect(Math.abs((a1.cost_usd as number) - 0.000321)).toBeLessThan(1e-9);
    expect(a1.turns).toBe(3);
    expect(a1.tool_calls).toBe(1);
    expect(Math.abs((a1.reasoning as number) - 20)).toBeLessThan(1e-9);
    expect(a1.reasoning_source).toBe('usage');
    expect(a1.input).toBe(2100);
    expect(a1.output).toBe(110);
    expect(a1.cache_write_5m).toBe(400);
    expect(a1.cache_read).toBe(600);
    expect(a1.gross_saving).toBeNull();
    expect(Math.abs((a1.margin_model as number) - 0.8)).toBeLessThan(1e-6);
    expect(Math.abs((a1.margin_effort as number) - 0.7)).toBeLessThan(1e-6);
    expect(Math.abs((a1.confidence_model as number) - 0.9)).toBeLessThan(1e-6);
    expect(Math.abs((a1.confidence_effort as number) - 0.8)).toBeLessThan(1e-6);
    expect(a1.end_stop_reason).toBe('tool_use');
    expect(a1.task_source).toBe('undetermined');
    expect(a1.attempt).toBeUndefined();

    const a2 = byTid['tid-2'];
    expect(a2.model_match).toBe('match');
    expect(Math.abs((a2.cost_usd as number) - 0.4015)).toBeLessThan(1e-9);
    expect(Math.abs((a2.gross_saving as number) - 0.4015)).toBeLessThan(1e-9);
    expect(a2.end_is_error).toBe(true);
    expect(a2.reasoning).toBeNull();
    expect(a2.reasoning_source).toBeNull();
    expect(a2.task_source).toBe('reviewer');
    expect(a2.decision_source_model).toBe('marker');
    expect(a2.marker).toBeTruthy();

    const a3 = byTid['tid-3'];
    expect(a3.model_match).toBe('mismatch');
    expect(a3.cost_status).toBe('partial');
    expect(Math.abs((a3.cost_usd as number) - 0.00606)).toBeLessThan(2e-9);
    expect(a3.turns_unpriced).toBe(1);
    expect(Math.abs((a3.reasoning as number) - 55)).toBeLessThan(1e-9);
    expect(a3.reasoning_source).toBe('block_length');
    expect(Math.abs((a3.gross_saving as number) + 0.00606)).toBeLessThan(2e-9);
    expect(a3.task_source).toBe('advisor');

    const a4 = byTid['tid-4'];
    expect(a4.model_match).toBe('match');
    expect(a4.cost_status).toBe('reported');
    expect(Math.abs((a4.cost_usd as number) - 0.000015)).toBeLessThan(1e-9);
    expect(Math.abs((a4.margin_model as number) - 0.6)).toBeLessThan(1e-6);
    expect(Math.abs((a4.margin_effort as number) - 0.2)).toBeLessThan(1e-6);
    expect(Math.abs((a4.confidence_model as number) - 0.6)).toBeLessThan(1e-6);
    expect(Math.abs((a4.confidence_effort as number) - 0.55)).toBeLessThan(1e-6);

    const a10 = byTid['tid-10'];
    expect(a10.model_match).toBe('no model decision');
    expect(a10.cost_status).toBe('reported');
    expect(Math.abs((a10.cost_usd as number) - 0.000153)).toBeLessThan(1e-9);

    const a6 = byTid['tid-6'];
    expect(a6.turns).toBe(0);
    expect(a6.cost_status).toBe('unavailable');
    expect(a6.cost_usd).toBeNull();
    expect(a6.model_match).toBe('undetermined');
    expect(a6.reasoning).toBeNull();

    // A12: subagent_type from the top level of the row (fallback)
    const a12 = byTid['tid-12'];
    expect(a12.subagent_type).toBe('custom-executor');
    expect(a12.task_source).toBe('custom-source');
    expect(a12.model_match).toBe('match');
    expect(a12.cost_status).toBe('reported');
    expect(Math.abs((a12.cost_usd as number) - 0.000153)).toBeLessThan(1e-9);

    // price consistency: the same cost by two functions (A1 + A2 + A3 + A4 + A10)
    expect(Math.abs(out.price_consistency.single_model_usd_p1 - 0.408202)).toBeLessThan(1e-6);
    expect(Math.abs(out.price_consistency.single_model_usd_p2 - 0.408202)).toBeLessThan(1e-6);
    expect(out.price_consistency.n).toBe(6);
    expect(out.price_consistency.consistent).toBe(true);
    expect(Math.abs(out.cost_sums.reported_partial_usd - 0.408202)).toBeLessThan(1e-6);
    expect(Math.abs(out.cost_sums.reported_only_usd - 0.402142)).toBeLessThan(1e-6);
    expect(out.cost_sums.total_usd).toBeNull();
    expect(out.cost_sums.n_unavailable).toBe(1);

    // Jev margins: all 3 decisions with a margin; below 0.1: 1 of 3 (model-tier); pointer prompts 2, full prompts 1
    const modelTier = out.margins['model-tier'];
    expect(modelTier.all.decisions).toBe(3);
    expect(modelTier.all.with_margin).toBe(3);
    expect(modelTier.all.below_01.k).toBe(1);
    expect(modelTier.all.below_01.n).toBe(3);
    expect(modelTier.pointer.decisions).toBe(2);
    expect(modelTier.pointer.below_01.k).toBe(0);
    expect(modelTier.pointer.below_01.n).toBe(2);
    expect(modelTier.full.decisions).toBe(1);
    expect(modelTier.full.below_01.k).toBe(1);
    expect(modelTier.full.below_01.n).toBe(1);
    const effort = out.margins.effort;
    expect(effort.all.below_01.k).toBe(0);
    expect(effort.all.below_01.n).toBe(3);
    expect(Math.abs(modelTier.all.mean_confidence - 2 / 3)).toBeLessThan(1e-3);
    expect(Math.abs(effort.all.mean_confidence - 0.65)).toBeLessThan(1e-3);

    // prices of the fixture are read from the file: no price table means no cost (covered below)
    expect(out.prices.haiku).toEqual(PRICES.haiku);

    // TSV: header + 7 agents (A1, A2, A3, A4, A6, A10, A12)
    const lines = readFileSync(tsvPath, 'utf8').trim().split('\n');
    expect(lines.length).toBe(8);
    const header = lines[0].split('\t');
    expect(header).toContain('cost_usd');
    expect(header).toContain('task_source');
    expect(header).not.toContain('attempt');
    const rowA1 = lines.filter((x) => x.split('\t')[header.indexOf('tool_use_id')] === 'tid-1');
    expect(rowA1.length).toBe(1);
    expect(rowA1[0].split('\t')[header.indexOf('cost_usd')]).toBe('0.000321');

    // output (stdout and files) does not contain the task text of the fixture
    const everything = result.stdout + readFileSync(tsvPath, 'utf8') + readFileSync(jsonPath, 'utf8');
    expect(everything.includes(MARKER)).toBe(false);
  });

  it('period filter removes rows outside the period (the row with an unreadable ts stays in the denominator)', () => {
    const planPath = join(base, 'result-period.json');
    const result = run(['--from', '2026-11-14T11:00:00Z', '--to', '2026-11-15T00:00:00Z', '--json', planPath]);
    expect(result.status, result.stderr).toBe(0);
    const out = JSON.parse(readFileSync(planPath, 'utf8'));
    expect(out.join.n).toBe(1);
    expect(out.join.k).toBe(0);
    expect(Array.isArray(out.join.wilson_1_96)).toBe(true);
    expect(out.join.share).toBe(0);
    expect(out.agents.length).toBe(0);
  });

  it('without --prices the price table is empty: one note on stderr, exit 0, every cost unavailable (null), never zero', () => {
    const noPrices = join(base, 'result-no-prices-option.json');
    const missing = spawnSync('python3', ['-I', SCRIPT, '--journal', journal, '--transcripts', transcripts, '--json', noPrices], { encoding: 'utf8' });
    expect(missing.status, missing.stderr).toBe(0);
    expect(missing.stderr.trim().split('\n').length).toBe(1);
    expect(missing.stderr).toMatch(/no --prices given/);
    const outMissing = JSON.parse(readFileSync(noPrices, 'utf8'));
    expect(outMissing.agents.length).toBe(7);
    for (const a of outMissing.agents) {
      expect(a.cost_usd).toBeNull();
      expect(a.gross_saving).toBeNull();
      expect(a.cost_status).toBe('unavailable');
    }
    expect(outMissing.prices).toEqual({});
    expect(missing.stdout).toMatch(/empty table: every cost is unavailable/);
    // an explicit empty table gives the same result without the note
    const emptyTable = join(base, 'empty-prices.json');
    writeFileSync(emptyTable, '{}');
    const planPath = join(base, 'result-noprices.json');
    const result = spawnSync('python3', ['-I', SCRIPT, '--journal', journal, '--transcripts', transcripts, '--prices', emptyTable, '--json', planPath], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    const out = JSON.parse(readFileSync(planPath, 'utf8'));
    expect(out.agents.length).toBe(7);
    for (const a of out.agents) {
      expect(a.cost_usd).toBeNull();
      expect(a.gross_saving).toBeNull();
      expect(a.cost_status).toBe('unavailable');
    }
    expect(out.cost_sums.total_usd).toBeNull();
    expect(out.price_consistency.consistent).toBe(false);
    expect(result.stdout).toMatch(/empty table: every cost is unavailable/);
  });

  it('--pointer-verbs adds a verb that marks a pointer prompt; without it the prompt is a full prompt', () => {
    const verbBase = mkdtempSync(join(tmpdir(), 'decision-outcome-join-verb-'));
    try {
      const verbJournal = join(verbBase, 'journal');
      write(join(verbJournal, 'shadow.jsonl'),
        JSON.stringify({
          ts: '2026-11-14T09:01:00.000Z', point: 'model-routing', mode: 'active', tool_use_id: 'tid-verb',
          state: { task: 'Summarize /tmp/notes.md for the team' },
          answers: { 'model-tier': { choice: 'haiku', probabilities: { haiku: 0.9, sonnet: 0.1 }, confidence: 0.9 } },
        }) + '\n');
      const plain = spawnSync('python3', ['-I', SCRIPT, '--journal', verbJournal, '--transcripts', verbBase, '--prices', prices, '--json', join(verbBase, 'a.json')], { encoding: 'utf8' });
      expect(plain.status, plain.stderr).toBe(0);
      const outPlain = JSON.parse(readFileSync(join(verbBase, 'a.json'), 'utf8'));
      expect(outPlain.margins['model-tier'].pointer.decisions).toBe(0);
      expect(outPlain.margins['model-tier'].full.decisions).toBe(1);
      const withVerb = spawnSync('python3', ['-I', SCRIPT, '--journal', verbJournal, '--transcripts', verbBase, '--prices', prices, '--pointer-verbs', 'summarize', '--json', join(verbBase, 'b.json')], { encoding: 'utf8' });
      expect(withVerb.status, withVerb.stderr).toBe(0);
      const outVerb = JSON.parse(readFileSync(join(verbBase, 'b.json'), 'utf8'));
      expect(outVerb.margins['model-tier'].pointer.decisions).toBe(1);
      expect(outVerb.margins['model-tier'].full.decisions).toBe(0);
    } finally {
      rmSync(verbBase, { recursive: true, force: true });
    }
  });

  it('the default pointer verbs are read and brief; execute and other words come through --pointer-verbs', () => {
    const verbBase = mkdtempSync(join(tmpdir(), 'decision-outcome-join-default-verbs-'));
    try {
      const verbJournal = join(verbBase, 'journal');
      const shadowRow = (toolUseId: string, task: string) => JSON.stringify({
        ts: '2026-11-14T09:01:00.000Z', point: 'model-routing', mode: 'active', tool_use_id: toolUseId,
        state: { task },
        answers: { 'model-tier': { choice: 'haiku', probabilities: { haiku: 0.9, sonnet: 0.1 }, confidence: 0.9 } },
      }) + '\n';
      write(join(verbJournal, 'shadow.jsonl'),
        shadowRow('tid-read', 'Read /tmp/notes.md')
        + shadowRow('tid-brief', 'Follow the brief in /tmp/notes.md')
        + shadowRow('tid-execute', 'Execute /tmp/notes.md'));
      const run3 = (extra: string[], name: string) => {
        const result = spawnSync('python3', ['-I', SCRIPT, '--journal', verbJournal, '--transcripts', verbBase, '--prices', prices, ...extra, '--json', join(verbBase, name)], { encoding: 'utf8' });
        expect(result.status, result.stderr).toBe(0);
        return JSON.parse(readFileSync(join(verbBase, name), 'utf8')).margins['model-tier'];
      };
      const plain = run3([], 'a.json');
      expect(plain.pointer.decisions).toBe(2);
      expect(plain.full.decisions).toBe(1);
      const withExecute = run3(['--pointer-verbs', 'execute'], 'b.json');
      expect(withExecute.pointer.decisions).toBe(3);
      expect(withExecute.full.decisions).toBe(0);
    } finally {
      rmSync(verbBase, { recursive: true, force: true });
    }
  });

  it('a bad price table or source-map entry is a usage error (exit 2)', () => {
    const bad = join(base, 'bad-prices.json');
    writeFileSync(bad, JSON.stringify({ haiku: [1, 2, 3] }));
    const badPrices = spawnSync('python3', ['-I', SCRIPT, '--journal', journal, '--transcripts', transcripts, '--prices', bad], { encoding: 'utf8' });
    expect(badPrices.status).toBe(2);
    expect(badPrices.stderr).toMatch(/--prices/);
    const badMap = spawnSync('python3', ['-I', SCRIPT, '--journal', journal, '--transcripts', transcripts, '--source-map', 'no-equals-sign'], { encoding: 'utf8' });
    expect(badMap.status).toBe(2);
    expect(badMap.stderr).toMatch(/--source-map/);
  });

  it('a rotated applied file with a process-id suffix (-<pid>) is read like the other rotated files', () => {
    const pidBase = mkdtempSync(join(tmpdir(), 'decision-outcome-join-pid-'));
    try {
      const pidJournal = join(pidBase, 'journal');
      const pidTranscripts = join(pidBase, 'transcripts');
      write(join(pidJournal, 'applied-20261114-080000-4242.jsonl'),
        row('tid-pid', 'ses-pid', 'executor', null, 'haiku', null, 'low'));
      write(join(pidTranscripts, 'project-p', 'ses-pid', 'subagents', 'agent-pid.meta.json'), meta('tid-pid', 'pid', 'haiku', 'low'));
      write(join(pidTranscripts, 'project-p', 'ses-pid', 'subagents', 'agent-pid.jsonl'), assistant('pid', 'claude-haiku-5-5', { usage: usage(1000, 0, 0, 0, 50) }));
      const planPath = join(pidBase, 'result.json');
      const result = spawnSync('python3', ['-I', SCRIPT, '--journal', pidJournal, '--transcripts', pidTranscripts, '--prices', prices, '--json', planPath], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      const out = JSON.parse(readFileSync(planPath, 'utf8'));
      expect(out.join.n).toBe(1);
      expect(out.join.k).toBe(1);
      expect(out.agents[0].tool_use_id).toBe('tid-pid');
    } finally {
      rmSync(pidBase, { recursive: true, force: true });
    }
  });
});

// Edge cases on one-agent fixtures. The applied row has the shape the routing hook writes: the subagent type sits
// inside the applied object, not at the top level of the row.
describe.skipIf(!hasPython3)('decision_outcome_join edge cases', () => {
  type Agent = Record<string, unknown>;
  const rawAssistant = (fields: Record<string, unknown>) => JSON.stringify({ type: 'assistant', ...fields }) + '\n';
  const apiErrorRow = (text: string) => rawAssistant({
    uuid: 'err-1',
    isApiErrorMessage: true,
    error: 'rate_limit',
    message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text }] },
  });

  /** One routed task (haiku) with the given transcript rows; returns the exit status, stderr and the agent rows. */
  function oneAgent(transcriptRows: string, priceTable: Record<string, number[]> | null, extra: string[] = []) {
    const dir = mkdtempSync(join(tmpdir(), 'decision-outcome-join-edge-'));
    try {
      write(join(dir, 'journal', 'applied.jsonl'), JSON.stringify({
        ts: '2026-11-14T09:10:00.000Z', point: 'model-routing', tool_use_id: 'tid-e', session_id: 'ses-e',
        applied: { subagent_type: 'executor', model: { from: 'haiku', to: 'haiku', source: 'jev' } },
      }) + '\n');
      write(join(dir, 'transcripts', 'project-p', 'ses-e', 'subagents', 'agent-e.meta.json'), meta('tid-e', 'e', 'haiku', 'low'));
      write(join(dir, 'transcripts', 'project-p', 'ses-e', 'subagents', 'agent-e.jsonl'), transcriptRows);
      const args = ['-I', SCRIPT, '--journal', join(dir, 'journal'), '--transcripts', join(dir, 'transcripts'), '--json', join(dir, 'out.json'), ...extra];
      if (priceTable) {
        writeFileSync(join(dir, 'prices.json'), JSON.stringify(priceTable));
        args.push('--prices', join(dir, 'prices.json'));
      }
      const result = spawnSync('python3', args, { encoding: 'utf8' });
      const out = result.status === 0 ? JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')) : null;
      return { status: result.status, stderr: result.stderr, out, agent: (out?.agents?.[0] ?? null) as Agent | null };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('prices a Haiku request above 100k tokens with the tier row alone (no base haiku row needed)', () => {
    const tierOnly = { 'haiku>100k': PRICES['haiku>100k'] };
    const big = assistant('big', 'claude-haiku-5-5', { usage: usage(100001, 0, 0, 0, 100) });
    const small = assistant('small', 'claude-haiku-5-5', { usage: usage(1000, 0, 0, 0, 100) });
    const result = oneAgent(big, tierOnly);
    expect(result.status, result.stderr).toBe(0);
    expect(result.agent!.cost_status).toBe('reported');
    expect(Math.abs((result.agent!.cost_usd as number) - (100001 * 0.5 + 100 * 2.5) / 1e6)).toBeLessThan(1e-6);
    expect(result.agent!.gross_saving).toBe(0);
    expect(result.out.price_consistency.consistent).toBe(true);
    // a request below the threshold has no row of its tier: unpriced, and the run still ends normally
    const mixed = oneAgent(big + small, tierOnly);
    expect(mixed.status, mixed.stderr).toBe(0);
    expect(mixed.agent!.cost_status).toBe('partial');
    expect(mixed.agent!.turns_unpriced).toBe(1);
  });

  it('counts a Haiku request above 100k tokens as unpriced when only the base haiku row exists', () => {
    const baseOnly = { haiku: PRICES.haiku };
    const big = assistant('big', 'claude-haiku-5-5', { usage: usage(100001, 0, 0, 0, 100) });
    const result = oneAgent(big, baseOnly);
    expect(result.status, result.stderr).toBe(0);
    expect(result.agent!.cost_status).toBe('unavailable');
    expect(result.agent!.cost_usd).toBeNull();
    expect(result.agent!.turns_unpriced).toBe(1);
    expect(result.agent!.gross_saving).toBeNull();
  });

  it('a turn without usage is unpriced, with or without a price table', () => {
    const noUsage = assistant('nu', 'claude-haiku-5-5');
    const withUsage = assistant('wu', 'claude-haiku-5-5', { usage: usage(1000, 0, 0, 0, 100) });
    const only = oneAgent(noUsage, PRICES);
    expect(only.status, only.stderr).toBe(0);
    expect(only.agent!.cost_status).toBe('unavailable');
    expect(only.agent!.cost_usd).toBeNull();
    expect(only.agent!.turns_unpriced).toBe(1);
    const mixed = oneAgent(noUsage + withUsage, PRICES);
    expect(mixed.agent!.cost_status).toBe('partial');
    expect(mixed.agent!.turns).toBe(2);
    expect(mixed.agent!.turns_unpriced).toBe(1);
    const unpriced = oneAgent(noUsage, null);
    expect(unpriced.agent!.cost_status).toBe('unavailable');
    expect(unpriced.agent!.cost_usd).toBeNull();
  });

  it('a row with usage but no message id is one priced turn (identified by its uuid)', () => {
    const noId = rawAssistant({ uuid: 'u-1', message: { model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'ok' }], usage: usage(1000, 0, 0, 0, 100) } });
    const result = oneAgent(noId, PRICES);
    expect(result.status, result.stderr).toBe(0);
    expect(result.agent!.turns).toBe(1);
    expect(result.agent!.turns_unpriced).toBe(0);
    expect(result.agent!.cost_status).toBe('reported');
  });

  it('reads a terminal API error row of the host as is_error and takes the status from its text', () => {
    const answer = assistant('ok', 'claude-haiku-5-5', { usage: usage(1000, 0, 0, 0, 100) });
    const failed = oneAgent(answer + apiErrorRow('API Error: Request rejected (429) rate limit reached'), PRICES);
    expect(failed.status, failed.stderr).toBe(0);
    expect(failed.agent!.end_is_error).toBe(true);
    expect(failed.agent!.end_api_error_status).toBe(429);
    // the error notice is not a model call
    expect(failed.agent!.turns).toBe(1);
    expect(failed.agent!.cost_status).toBe('reported');
    const noStatus = oneAgent(answer + apiErrorRow('API Error: connection closed'), PRICES);
    expect(noStatus.agent!.end_is_error).toBe(true);
    expect(noStatus.agent!.end_api_error_status).toBeNull();
    // an error followed by a normal answer is not terminal
    const recovered = oneAgent(apiErrorRow('API Error: Request rejected (529)') + answer, PRICES);
    expect(recovered.agent!.end_is_error).toBeNull();
    expect(recovered.agent!.end_api_error_status).toBeNull();
  });

  it('usage sub-objects and rows that are not objects do not end the run', () => {
    const odd = rawAssistant({
      message: { id: 'msg-odd', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'ok' }], usage: { ...usage(1000, 0, 0, 0, 100), output_tokens_details: 5, cache_creation: 7 } },
    });
    const result = oneAgent('"not an object"\n' + odd, PRICES);
    expect(result.status, result.stderr).toBe(0);
    expect(result.agent!.turns).toBe(1);
    expect(result.agent!.input).toBe(1000);
  });

  it('uses the first copy (by path) of a tool_use_id that two transcript directories both hold', () => {
    const dir = mkdtempSync(join(tmpdir(), 'decision-outcome-join-copies-'));
    try {
      write(join(dir, 'journal', 'applied.jsonl'), row('tid-copy', 'ses-copy', 'executor', null, 'haiku', null, 'low'));
      for (const [project, agentId] of [['project-b', 'second'], ['project-a', 'first'], ['project-c', 'third']]) {
        write(join(dir, 'transcripts', project, 'ses-copy', 'subagents', `agent-${agentId}.meta.json`), meta('tid-copy', agentId, 'haiku', 'low'));
        write(join(dir, 'transcripts', project, 'ses-copy', 'subagents', `agent-${agentId}.jsonl`), assistant(agentId, 'claude-haiku-5-5', { usage: usage(1000, 0, 0, 0, 50) }));
      }
      const result = spawnSync('python3', ['-I', SCRIPT, '--journal', join(dir, 'journal'), '--transcripts', join(dir, 'transcripts'), '--json', join(dir, 'out.json')], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')).agents[0].agent_id).toBe('first');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts a replayed tool call once', () => {
    const call = { type: 'tool_use', id: 'toolu-1', name: 'Read', input: { file_path: '/tmp/a' } };
    const first = assistant('r1', 'claude-haiku-5-5', { content: [call], usage: usage(1000, 0, 0, 0, 100) });
    const replay = assistant('r2', 'claude-haiku-5-5', { content: [call, { type: 'tool_use', id: 'toolu-2', name: 'Read', input: { file_path: '/tmp/b' } }], usage: usage(1000, 0, 0, 0, 100) });
    const result = oneAgent(first + replay, PRICES);
    expect(result.status, result.stderr).toBe(0);
    expect(result.agent!.tool_calls).toBe(2);
  });
});
