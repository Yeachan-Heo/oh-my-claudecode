import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, it } from 'vitest';

// Tests for tools/diagnostics/compare_sessions.py on synthetic transcripts. The script needs python3;
// the suite is skipped when python3 is not installed.
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'diagnostics', 'compare_sessions.py');
const hasPython3 = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;
if (!hasPython3) console.warn('compare_sessions.py tests are skipped: python3 is not available');

const at = (hms: string, ms = 0) => `2026-11-14T${hms}.${String(ms).padStart(3, '0')}Z`;

function userLine(ts: string, content: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'user', sessionId: 's', uuid: 'u', parentUuid: null, timestamp: ts, message: { role: 'user', content }, ...extra });
}
function assistantLine(ts: string, model: string, stopReason: string, blocks: unknown[], msgId = 'msg', extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'assistant', sessionId: 's', uuid: 'a', parentUuid: 'u', timestamp: ts, message: { role: 'assistant', id: msgId, model, stop_reason: stopReason, content: blocks }, ...extra });
}
function toolUse(id: string, name: string, input: Record<string, unknown> = {}) {
  return { type: 'tool_use', id, name, input };
}
function toolResult(id: string, content: unknown, isError?: boolean) {
  const block: Record<string, unknown> = { type: 'tool_result', tool_use_id: id, content };
  if (isError !== undefined) block.is_error = isError;
  return block;
}
// assertion helper: the whole result must not contain verdict or regression words;
// the threshold note describes the threshold with such words, so it is left out of the scan
function withoutThresholdNote(x: unknown): string {
  return JSON.stringify(x, (k, v) => (k === 'time_threshold_note' ? undefined : v));
}

// shapes of the JSON printed by the script (only the fields the tests read)
interface Metrics {
  duration_ms: number; tool_calls: number; failures: number; incomplete: number;
  turns_started: number; turns_ended: number; turns_interrupted: number; turns_ended_by_api_error: number;
  messages_mid_turn: number; messages_mid_turn_by_source: Record<string, number>; turns_started_by_source: Record<string, number>;
  compactions: number; server_tool_use: number; advisor_tool_result: number;
}
interface Gaps {
  incomplete_tool_calls: number; incomplete_across_compaction: number; orphan_results: number;
  unclosed_turns: number; unclosed_turn_list: { file: string; timestamp: string }[];
  no_tool_calls: number; unmeasured_tool_calls: number; ends_without_turn: number; api_errors_without_turn: number;
}
interface ToolStats { calls: number; failures: number; incomplete: number; measured: number; total_ms: number; mean_ms: number | null }
interface SessionFile { role: string; file: string; valid_lines: number }
interface SessionState {
  metrics: Metrics; models: string[]; bad_lines: number; gaps: Gaps;
  tools: Record<string, ToolStats>; files: SessionFile[];
}
interface MeanTime { a: number | null; b: number | null; percent: number | null; above_threshold: boolean | null }
interface ToolComparison { tool: string; presence: string; time_comparable: boolean; comparison: { mean_time_ms: MeanTime } }
interface CompareResult {
  mode: string; a: SessionState; b: SessionState;
  comparison: {
    metrics: Record<string, { a: number; b: number; delta: number; percent: number | null }>;
    models: { a: string[]; b: string[]; added: string[]; removed: string[] };
    tools: ToolComparison[];
  };
}
interface TimelineEvent {
  kind: string; time: string | null; id?: string; tool?: string; status?: string;
  duration_ms?: number; before_compaction?: boolean;
}
interface TimelineResult { mode: string; session: string; duration_ms: number; events: TimelineEvent[] }

// a lookup that must succeed: fails the test (and narrows the type) when the value is missing
function must<T>(value: T | undefined): T {
  assert.ok(value !== undefined, 'expected value is missing');
  return value;
}

function writeSession(dir: string, name: string, lines: string[], subagentLines: string[] | null = null): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  if (subagentLines !== null) {
    fs.mkdirSync(path.join(dir, name, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'subagents', 'agent-x.jsonl'), subagentLines.length ? subagentLines.join('\n') + '\n' : '');
  }
  return file;
}

function run(args: string[]) {
  return spawnSync('python3', ['-I', SCRIPT, ...args], { encoding: 'utf8' });
}
function runJson<T>(args: string[]): T {
  const p = run(args);
  assert.equal(p.status, 0, `exit ${p.status}: ${p.stderr}`);
  return JSON.parse(p.stdout) as T;
}
// turn consistency: turns_started = turns_ended + turns_ended_by_api_error + turns_interrupted + unclosed_turns
function expectConsistentTurns(state: SessionState) {
  const m = state.metrics;
  assert.equal(
    m.turns_started,
    m.turns_ended + m.turns_ended_by_api_error + m.turns_interrupted + state.gaps.unclosed_turns,
    `turn consistency: ${JSON.stringify(m)} gaps ${JSON.stringify(state.gaps)}`,
  );
}

// ---- main fixture: session A (3 Bash/Read calls, failure with flag, interrupt text, bad line, blob) ----
const FIXTURE_A = [
  userLine(at('12:00:00'), 'start the task SECRET-CONTENT'),
  assistantLine(at('12:00:01'), 'claude-opus-5-5', 'tool_use', [toolUse('toolu_1', 'Bash', { command: 'echo SECRET' })], 'msg_A1'),
  userLine(at('12:00:05'), [toolResult('toolu_1', 'Exit code 1: critical error', true)]),
  assistantLine(at('12:00:06'), 'claude-opus-5-5', 'tool_use', [toolUse('toolu_2', 'Bash', { command: 'echo second' })], 'msg_A2'),
  userLine(at('12:00:08'), [toolResult('toolu_2', 'done; text contains the word error, but the flag is false', false)]),
  assistantLine(at('12:00:10'), 'claude-opus-5-5', 'tool_use', [toolUse('toolu_3', 'Read', { file_path: '/tmp/SECRET' })], 'msg_A3'),
  userLine(at('12:00:11'), [toolResult('toolu_3', 'file read', undefined)]),
  assistantLine(at('12:00:12'), 'claude-opus-5-5', 'end_turn', [{ type: 'text', text: 'done SECRET-CONTENT' }], 'msg_A4'),
  userLine(at('12:00:13'), 'new turn SECRET-CONTENT'),
  assistantLine(at('12:00:14'), 'claude-opus-5-5', 'tool_use', [toolUse('toolu_A5', 'Bash')], 'msg_A5'),
  userLine(at('12:00:15'), '[Request interrupted by user]'),
  JSON.stringify({ type: 'api-request-blob', sessionId: 'ses-a', hash: 'h1', message: { content: [toolResult('toolu_1', 'duplicate', false)] } }),
  'this is not JSON',
];

// ---- main fixture: session B (split response dedup, block interrupt, compaction not closing a turn,
// message mid-turn, orphan, server_tool_use without id, file ends with an open turn, subagent) ----
const FIXTURE_B = [
  userLine(at('12:00:00'), 'start the task SECRET-CONTENT'),
  assistantLine(at('12:00:02'), 'model-x', 'tool_use', [toolUse('toolu_B1', 'Bash', { command: 'echo SECRET' })], 'msg_B1'),
  userLine(at('12:00:04'), [toolResult('toolu_B1', 'done', false)]),
  assistantLine(at('12:00:05'), 'model-x', 'tool_use', [toolUse('toolu_B2', 'Bash')], 'msg_B2'),
  assistantLine(at('12:00:05'), 'model-x', 'tool_use', [{ type: 'text', text: 'same message.id msg_B2, other block' }], 'msg_B2'),
  userLine(at('12:00:07'), [toolResult('toolu_B2', 'done', false)]),
  userLine(at('12:00:07', 500), [toolResult('toolu_X1', 'result without call (orphan)', false)]),
  assistantLine(at('12:00:08'), 'model-x', 'end_turn', [{ type: 'text', text: 'part end of turn 1' }], 'msg_B3'),
  assistantLine(at('12:00:08'), 'model-a', 'end_turn', [{ type: 'server_tool_use', name: 'web_search' }], 'msg_B3'),
  userLine(at('12:01:00'), 'turn 2 SECRET-CONTENT'),
  assistantLine(at('12:01:01'), 'model-x', 'tool_use', [toolUse('toolu_B3', 'Grep', { pattern: 'SECRET' })], 'msg_B4'),
  userLine(at('12:01:02'), [{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
  userLine(at('12:02:00'), 'turn 3 SECRET-CONTENT'),
  assistantLine(at('12:02:01'), 'model-x', 'tool_use', [toolUse('toolu_B4', 'Read')], 'msg_B5'),
  JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual', preTokens: 227786, postTokens: 25454 }, timestamp: at('12:02:02') }),
  userLine(at('12:02:03'), 'turn 4 SECRET-CONTENT'),
  assistantLine(at('12:02:04'), 'model-x', 'tool_use', [toolUse('toolu_B5', 'Write')], 'msg_B6'),
];
const FIXTURE_B_AGENT = [
  userLine(at('12:00:30'), 'subagent task'),
  assistantLine(at('12:00:30', 500), 'claude-haiku-5-5', 'tool_use', [toolUse('toolu_SA1', 'Bash')], 'msg_SA1'),
  userLine(at('12:00:35'), [toolResult('toolu_SA1', 'subagent error', true)]),
  assistantLine(at('12:00:36'), 'claude-haiku-5-5', 'end_turn', [{ type: 'text', text: 'subagent end' }], 'msg_SA2'),
];

// ---- turn fixture 1: session interrupted twice by an API limit error ----
const FIXTURE_API_ERRORS = [
  userLine(at('08:00:00'), 'Read the file and fix the code.', { origin: { kind: 'human' } }),
  assistantLine(at('08:00:01'), 'model-x', 'tool_use', [toolUse('toolu_G1', 'Bash')], 'msg_G1'),
  userLine(at('08:00:02'), [toolResult('toolu_G1', 'ok', false)]),
  assistantLine(at('08:00:03'), '<synthetic>', 'stop_sequence', [{ type: 'text', text: 'API Error: Request rejected (429) · Rate limit reached for requests' }], 'msg_syn1', { isApiErrorMessage: true, error: 'rate_limit' }),
  userLine(at('08:00:10'), 'Continue the task from the brief.', { origin: { kind: 'human' } }),
  assistantLine(at('08:00:11'), '<synthetic>', 'stop_sequence', [{ type: 'text', text: 'API Error: Request rejected (429) · Rate limit reached for requests' }], 'msg_syn2', { isApiErrorMessage: true, error: 'rate_limit' }),
  userLine(at('08:00:20'), 'Continue the task from the brief.', { origin: { kind: 'human' } }),
  assistantLine(at('08:00:21'), 'model-x', 'tool_use', [toolUse('toolu_G2', 'Read')], 'msg_G2'),
  userLine(at('08:00:22'), 'Output token limit hit. Resume the task.', { isMeta: true }),
  assistantLine(at('08:00:23'), 'model-x', 'end_turn', [{ type: 'text', text: 'end of work' }], 'msg_G3'),
  assistantLine(at('08:00:32'), 'model-x', 'end_turn', [{ type: 'text', text: 'end again' }], 'msg_G4'),
];

// ---- turn fixture 2: one turn with two messages mid-turn (reminder, task notification) ----
const FIXTURE_MID_TURN = [
  userLine(at('09:00:00'), 'main task', { origin: { kind: 'human' } }),
  userLine(at('09:00:01'), '<system-reminder>system reminder</system-reminder>', { isMeta: true }),
  userLine(at('09:00:02'), '<task-notification>background task finished</task-notification>', { origin: { kind: 'task-notification' } }),
  assistantLine(at('09:00:03'), 'claude-opus-5-5', 'end_turn', [{ type: 'text', text: 'done' }], 'msg_W1'),
];

// ---- turn fixture 3: message from another session (peer) wakes the model and opens a turn ----
const FIXTURE_PEER = [
  userLine(at('09:10:00'), '<task-notification>message from another session</task-notification>', { isMeta: true, origin: { kind: 'peer' } }),
  assistantLine(at('09:10:05'), 'model-x', 'end_turn', [{ type: 'text', text: 'received' }], 'msg_P1'),
];

// ---- turn fixture 4: compaction inside a turn (boundary, summary, synthetic traces) ----
const FIXTURE_COMPACTION = [
  userLine(at('09:20:00'), 'task before compaction', { origin: { kind: 'human' } }),
  assistantLine(at('09:20:01'), 'model-x', 'tool_use', [toolUse('toolu_K1', 'Bash')], 'msg_K1'),
  userLine(at('09:20:02'), [toolResult('toolu_K1', 'ok', false)]),
  JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual', preTokens: 1000, postTokens: 200 }, timestamp: at('09:20:03') }),
  assistantLine(at('09:20:04'), '<synthetic>', 'stop_sequence', [{ type: 'text', text: '[trace after compaction] rest of the reply carried over' }], 'msg_synK'),
  assistantLine(at('09:20:04', 100), '<synthetic>', 'stop_sequence', [{ type: 'tool_use', id: 'toolu_syn_dup', name: 'Bash' }], 'msg_synK2'),
  userLine(at('09:20:05'), 'compaction summary', { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
  assistantLine(at('09:20:06'), 'model-x', 'end_turn', [{ type: 'text', text: 'end after compaction' }], 'msg_K2'),
];

// ---- turn fixture 5: interrupt in one line with a tool_result and in a separate line ----
const FIXTURE_INTERRUPTS = [
  userLine(at('09:30:00'), 'first task'),
  assistantLine(at('09:30:01'), 'model-x', 'tool_use', [toolUse('toolu_P1', 'Bash')], 'msg_P1'),
  userLine(at('09:30:02'), [toolResult('toolu_P1', 'partial result', false), { type: 'text', text: '[Request interrupted by user for tool use]' }]),
  userLine(at('09:30:03'), 'second task'),
  assistantLine(at('09:30:04'), 'model-x', 'tool_use', [toolUse('toolu_P2', 'Bash')], 'msg_P2'),
  userLine(at('09:30:05'), [{ type: 'text', text: '[Request interrupted by user]' }]),
];

// ---- turn fixture 6: file ends with an open turn ----
const FIXTURE_OPEN = [
  userLine(at('09:40:00'), 'task without end', { origin: { kind: 'human' } }),
  assistantLine(at('09:40:01'), 'model-x', 'tool_use', [toolUse('toolu_U1', 'Bash')], 'msg_U1'),
];

// ---- turn fixture 7: server_tool_use deduplicated by id, advisor_tool_result by tool_use_id ----
const FIXTURE_SERVER = [
  userLine(at('09:50:00'), 'task with advisor'),
  assistantLine(at('09:50:01'), 'claude-opus-5-5', 'tool_use', [
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search' },
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search' }, // duplicate id: not counted
    { type: 'server_tool_use', name: 'web_search' }, // no id: counted by position
    { type: 'server_tool_use', name: 'advisor' }, // no id: counted by position
  ], 'msg_S1'),
  assistantLine(at('09:50:02'), 'claude-opus-5-5', 'end_turn', [
    { type: 'advisor_tool_result', tool_use_id: 'srvtoolu_1' },
    { type: 'advisor_tool_result', tool_use_id: 'srvtoolu_1' }, // duplicate tool_use_id: not counted
    { type: 'advisor_tool_result' }, // no tool_use_id: counted by position
  ], 'msg_S2'),
];

describe.skipIf(!hasPython3)('compare_sessions.py', () => {
  let dir = '';
  let fileA = '';
  let fileB = '';

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-sessions-'));
    fileA = writeSession(path.join(dir, 'dir-a'), 'ses-a', FIXTURE_A);
    fileB = writeSession(path.join(dir, 'dir-b'), 'ses-b', FIXTURE_B, FIXTURE_B_AGENT);
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('comparison A/B: metrics, per tool, gaps, models, blob skipped, bad line, split-response dedup', () => {
    const result = runJson<CompareResult>(['--a', fileA, '--b', fileB]);

    // metrics of session A
    assert.deepEqual(result.a.metrics, {
      duration_ms: 15000, tool_calls: 4, failures: 1, incomplete: 1,
      turns_started: 2, turns_ended: 1, turns_interrupted: 1, turns_ended_by_api_error: 0,
      messages_mid_turn: 0, messages_mid_turn_by_source: {}, turns_started_by_source: { none: 2 },
      compactions: 0, server_tool_use: 0, advisor_tool_result: 0,
    });
    assert.deepEqual(result.a.models, ['claude-opus-5-5']);
    assert.equal(result.a.bad_lines, 1);
    assert.deepEqual(result.a.gaps, {
      incomplete_tool_calls: 1, incomplete_across_compaction: 0, orphan_results: 0,
      unclosed_turns: 0, unclosed_turn_list: [], no_tool_calls: 0, unmeasured_tool_calls: 1,
      ends_without_turn: 0, api_errors_without_turn: 0,
    });
    assert.deepEqual(result.a.tools.Bash, { calls: 3, failures: 1, incomplete: 1, measured: 2, total_ms: 6000, mean_ms: 3000 });
    assert.deepEqual(result.a.tools.Read, { calls: 1, failures: 0, incomplete: 0, measured: 1, total_ms: 1000, mean_ms: 1000 });
    assert.deepEqual(result.a.files.map((p) => p.role), ['main']);
    expectConsistentTurns(result.a);

    // metrics of session B (with subagent)
    assert.deepEqual(result.b.metrics, {
      duration_ms: 124000, tool_calls: 6, failures: 1, incomplete: 1,
      turns_started: 4, turns_ended: 2, turns_interrupted: 1, turns_ended_by_api_error: 0,
      messages_mid_turn: 1, messages_mid_turn_by_source: { none: 1 }, turns_started_by_source: { none: 4 },
      compactions: 1, server_tool_use: 1, advisor_tool_result: 0,
    });
    assert.deepEqual(result.b.models, ['claude-haiku-5-5', 'model-a', 'model-x']);
    assert.equal(result.b.bad_lines, 0);
    assert.deepEqual(result.b.gaps, {
      incomplete_tool_calls: 1, incomplete_across_compaction: 2, orphan_results: 1,
      unclosed_turns: 1, unclosed_turn_list: [{ file: fileB, timestamp: at('12:02:00') }],
      no_tool_calls: 0, unmeasured_tool_calls: 3,
      ends_without_turn: 1, api_errors_without_turn: 0,
    });
    assert.deepEqual(result.b.tools.Bash, { calls: 3, failures: 1, incomplete: 0, measured: 3, total_ms: 8500, mean_ms: 8500 / 3 });
    assert.deepEqual(result.b.tools.Grep, { calls: 1, failures: 0, incomplete: 0, measured: 0, total_ms: 0, mean_ms: null });
    assert.deepEqual(result.b.tools.Read, { calls: 1, failures: 0, incomplete: 0, measured: 0, total_ms: 0, mean_ms: null });
    assert.deepEqual(result.b.tools.Write, { calls: 1, failures: 0, incomplete: 1, measured: 0, total_ms: 0, mean_ms: null });
    assert.equal(result.b.files.length, 2);
    assert.deepEqual(result.b.files.map((p) => p.role), ['main', 'subagent']);
    assert.ok(result.b.files[1].file.includes(path.join('ses-b', 'subagents', 'agent-x.jsonl')), result.b.files[1].file);
    expectConsistentTurns(result.b);

    // comparison
    const cmp = result.comparison;
    assert.equal(cmp.metrics.tool_calls.a, 4);
    assert.equal(cmp.metrics.tool_calls.b, 6);
    assert.equal(cmp.metrics.tool_calls.delta, 2);
    assert.equal(cmp.metrics.tool_calls.percent, 50);
    assert.ok('messages_mid_turn' in cmp.metrics);
    assert.ok('advisor_tool_result' in cmp.metrics);
    assert.deepEqual(cmp.models, {
      a: ['claude-opus-5-5'],
      b: ['claude-haiku-5-5', 'model-a', 'model-x'],
      added: ['claude-haiku-5-5', 'model-a', 'model-x'],
      removed: ['claude-opus-5-5'],
    });
    const bash = must(cmp.tools.find((n) => n.tool === 'Bash'));
    assert.equal(bash.presence, 'both');
    assert.equal(bash.time_comparable, false); // A: 2 of 3 calls measured
    assert.equal(bash.comparison.mean_time_ms.percent, null);
    assert.equal(bash.comparison.mean_time_ms.above_threshold, null);
    const read = must(cmp.tools.find((n) => n.tool === 'Read'));
    assert.equal(read.comparison.mean_time_ms.a, 1000);
    assert.equal(read.comparison.mean_time_ms.b, null);
    const grep = must(cmp.tools.find((n) => n.tool === 'Grep'));
    assert.equal(grep.presence, 'only_b');
    // the blob with a duplicate tool_result of toolu_1 did not raise orphan_results in A (0) or the counters
    assert.equal(result.a.gaps.orphan_results, 0);
    // no verdict field: scan the whole JSON except the threshold note
    assert.ok(!/verdict|regression/i.test(withoutThresholdNote(result)), 'result contains the word verdict or regression');
  });

  it('--no-subagents: main file only', () => {
    const result = runJson<CompareResult>(['--a', fileA, '--b', fileB, '--no-subagents']);
    assert.equal(result.b.files.length, 1);
    assert.equal(result.b.tools.Bash.calls, 2);
    assert.equal(result.b.tools.Bash.failures, 0);
    assert.equal(result.b.tools.Bash.mean_ms, 2000);
    assert.equal(result.b.metrics.tool_calls, 5);
    assert.equal(result.b.metrics.failures, 0);
    assert.equal(result.b.metrics.turns_started, 3);
    assert.equal(result.b.metrics.turns_ended, 1);
    assert.equal(result.b.metrics.messages_mid_turn, 1);
    assert.equal(result.b.metrics.duration_ms, 124000); // the subagent does not widen the time range
    assert.deepEqual(result.b.models, ['model-a', 'model-x']);
  });

  it('large time growth: above_threshold true, exit 0, no verdict field', () => {
    const fixture = (id: string, resultTs: string, endTs: string) => [
      userLine(at('10:00:00'), 'task'),
      assistantLine(at('10:00:01'), 'claude-opus-5-5', 'tool_use', [toolUse(`toolu_${id}`, 'Bash')], `msg_${id}`),
      userLine(resultTs, [toolResult(`toolu_${id}`, 'ok', false)]),
      assistantLine(endTs, 'claude-opus-5-5', 'end_turn', [{ type: 'text', text: 'end' }], `msg_k_${id}`),
    ];
    const growA = writeSession(path.join(dir, 'dir-a2'), 'ses-a2', fixture('A2', at('10:00:02'), at('10:00:03')));
    const growB = writeSession(path.join(dir, 'dir-b2'), 'ses-b2', fixture('B2', at('10:00:06'), at('10:00:07')));
    const result = runJson<CompareResult>(['--a', growA, '--b', growB]);
    const bash = must(result.comparison.tools.find((n) => n.tool === 'Bash'));
    assert.equal(bash.time_comparable, true);
    assert.equal(bash.comparison.mean_time_ms.a, 1000);
    assert.equal(bash.comparison.mean_time_ms.b, 5000);
    assert.equal(bash.comparison.mean_time_ms.percent, 400);
    assert.equal(bash.comparison.mean_time_ms.above_threshold, true); // 400 % > threshold 20 %
    assert.equal(result.comparison.metrics.failures.b, 0);
    assert.ok(!/verdict|regression/i.test(withoutThresholdNote(result)), 'result contains the word verdict or regression');
  });

  it('mean tool time of A equal to 0 ms: percent null, exit 0', () => {
    // a call and its result with the same timestamp: mean 0 ms on side A
    const fixture = (id: string, base: string) => [
      userLine(at(base), 'task'),
      assistantLine(at(base, 100), 'claude-opus-5-5', 'tool_use', [toolUse(`toolu_${id}`, 'Bash')], `msg_${id}`),
      userLine(at(base, 100), [toolResult(`toolu_${id}`, 'ok', false)]), // 0 ms
      assistantLine(at(base, 200), 'claude-opus-5-5', 'end_turn', [{ type: 'text', text: 'end' }], `msg_k_${id}`),
    ];
    const zeroA = writeSession(path.join(dir, 'dir-zero-a'), 'ses-za', fixture('Z1', '11:00:00'));
    const zeroB = writeSession(path.join(dir, 'dir-zero-b'), 'ses-zb', fixture('Z2', '11:00:10'));
    const result = runJson<CompareResult>(['--a', zeroA, '--b', zeroB]);
    const bash = must(result.comparison.tools.find((n) => n.tool === 'Bash'));
    assert.equal(bash.time_comparable, true);
    assert.equal(bash.comparison.mean_time_ms.a, 0);
    assert.equal(bash.comparison.mean_time_ms.percent, null);
    assert.equal(bash.comparison.mean_time_ms.above_threshold, null);
  });

  it('empty subagent file: exit 0, valid_lines 0; line without timestamp: exit 0, fields null', () => {
    const emptySubA = writeSession(path.join(dir, 'dir-empty-sub'), 'ses-ps', FIXTURE_A, []);
    const result = runJson<CompareResult>(['--a', emptySubA, '--b', fileB]);
    assert.equal(result.a.files.length, 2);
    assert.equal(result.a.files[1].valid_lines, 0);
    // a session with a line without timestamp next to lines with one: exit 0, the line without time gets null
    const mixed = [
      userLine(at('09:55:00'), 'task'),
      JSON.stringify({ type: 'assistant', sessionId: 's', uuid: 'a', parentUuid: 'u', message: { role: 'assistant', id: 'msg_nt', model: 'model-x', stop_reason: 'end_turn', content: [{ type: 'text', text: 'end' }] } }),
    ];
    const fileMixed = writeSession(path.join(dir, 'dir-mixed'), 'ses-mixed', mixed);
    const timeline = runJson<TimelineResult>(['--timeline', fileMixed]);
    assert.equal(timeline.events.length, 2);
    // the line without timestamp sorts first (no time), then the line with a time
    assert.equal(timeline.events[0].kind, 'turn_end');
    assert.equal(timeline.events[0].time, null);
    assert.equal(timeline.events[1].kind, 'turn_start');
    assert.equal(timeline.events[1].time, at('09:55:00'));
    assert.equal(timeline.duration_ms, 0);
  });

  it('--output: creates a new file with mode 0600, refuses to overwrite (exit 1)', () => {
    const target = path.join(dir, 'comparison-output.json');
    const p = run(['--a', fileA, '--b', fileB, '--output', target]);
    assert.equal(p.status, 0, p.stderr);
    assert.equal(p.stdout, '');
    const stat = fs.statSync(target);
    assert.equal(stat.mode & 0o777, 0o600);
    const written = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.equal(written.mode, 'compare');
    const p2 = run(['--a', fileA, '--b', fileB, '--output', target]);
    assert.equal(p2.status, 1);
    assert.match(p2.stderr, /exists/);
  });

  it('--timeline: events in non-decreasing time order, no input or result content', () => {
    const result = runJson<TimelineResult>(['--timeline', fileB]);
    assert.equal(result.mode, 'timeline');
    assert.equal(result.session, 'ses-b');
    assert.equal(result.duration_ms, 124000);
    const events = result.events;
    const kinds = events.map((z) => z.kind);
    assert.ok(kinds.includes('turn_start') && kinds.includes('turn_end') && kinds.includes('turn_interrupted'));
    assert.ok(kinds.includes('compaction') && kinds.includes('tool_call') && kinds.includes('result'));
    assert.ok(kinds.includes('message_mid_turn'));
    // time is an ISO string for the fixture events (all lines have a timestamp) and the order is non-decreasing
    const withStatus = events.filter((z) => z.kind !== 'tool_call_no_result');
    for (const z of withStatus) assert.equal(typeof z.time, 'string', `time is not a string: ${JSON.stringify(z)}`);
    const times = withStatus.map((z) => z.time);
    const sorted = [...times].sort();
    assert.deepEqual(times, sorted);
    // calls without result at the end of the list
    assert.equal(kinds[kinds.length - 1], 'tool_call_no_result');
    assert.equal(kinds.filter((r) => r === 'tool_call_no_result').length, 3); // B3, B4, B5
    assert.equal(typeof must(events.find((z) => z.kind === 'tool_call_no_result')).time, 'string');
    // no content: no text from the fixtures appears
    const all = JSON.stringify(events);
    for (const fragment of ['SECRET-CONTENT', 'SECRET', 'subagent error', 'duplicate', '[Request interrupted', 'same message.id', 'result without call']) {
      assert.ok(!all.includes(fragment), `content in timeline: ${fragment}`);
    }
    const call = must(events.find((z) => z.kind === 'tool_call' && z.id === 'toolu_B1'));
    assert.deepEqual(Object.keys(call).sort(), ['id', 'kind', 'time', 'tool']);
    const res = must(events.find((z) => z.kind === 'result' && z.id === 'toolu_B1'));
    assert.equal(res.status, 'ok');
    assert.equal(res.duration_ms, 2000);
    const resSub = must(events.find((z) => z.kind === 'result' && z.id === 'toolu_SA1'));
    assert.equal(resSub.status, 'failure');
    const noResult = events.filter((z) => z.kind === 'tool_call_no_result');
    assert.deepEqual(noResult.map((z) => z.before_compaction), [true, true, false]); // B3, B4 before; B5 after
  });

  it('turns: session interrupted twice by an API error, then a token limit and a double end_turn', () => {
    const file = writeSession(path.join(dir, 'dir-api-errors'), 'ses-api-errors', FIXTURE_API_ERRORS);
    const timeline = runJson<TimelineResult>(['--timeline', file]);
    const full = runJson<CompareResult>(['--a', file, '--b', file]);
    const metrics = full.a.metrics;
    assert.equal(metrics.turns_started, 3);
    assert.equal(metrics.turns_ended, 1);
    assert.equal(metrics.turns_ended_by_api_error, 2);
    assert.equal(metrics.turns_interrupted, 0);
    assert.equal(metrics.messages_mid_turn, 1);
    assert.deepEqual(metrics.turns_started_by_source, { human: 3 });
    assert.deepEqual(metrics.messages_mid_turn_by_source, { none: 1 });
    assert.equal(full.a.gaps.unclosed_turns, 0);
    assert.equal(full.a.gaps.ends_without_turn, 1);
    assert.equal(full.a.gaps.api_errors_without_turn, 0);
    // synthetic lines do not enter models or calls
    assert.deepEqual(full.a.models, ['model-x']);
    assert.equal(metrics.tool_calls, 2);
    // the API-error close event on the timeline
    const kinds = timeline.events.map((z) => z.kind);
    assert.equal(kinds.filter((r) => r === 'turn_end_api_error').length, 2);
    expectConsistentTurns(full.a);
  });

  it('turns: two messages mid-turn do not open new turns', () => {
    const file = writeSession(path.join(dir, 'dir-midturn'), 'ses-midturn', FIXTURE_MID_TURN);
    const result = runJson<CompareResult>(['--a', file, '--b', file]);
    const metrics = result.a.metrics;
    assert.equal(metrics.turns_started, 1);
    assert.equal(metrics.messages_mid_turn, 2);
    assert.deepEqual(metrics.turns_started_by_source, { human: 1 });
    assert.deepEqual(metrics.messages_mid_turn_by_source, { none: 1, 'task-notification': 1 });
    assert.equal(result.a.gaps.unclosed_turns, 0);
    assert.equal(metrics.turns_ended, 1);
    expectConsistentTurns(result.a);
  });

  it('turns: message from another session (peer) with no open turn opens a turn', () => {
    const file = writeSession(path.join(dir, 'dir-peer'), 'ses-peer', FIXTURE_PEER);
    const result = runJson<CompareResult>(['--a', file, '--b', file]);
    const metrics = result.a.metrics;
    assert.equal(metrics.turns_started, 1);
    assert.deepEqual(metrics.turns_started_by_source, { peer: 1 });
    assert.equal(metrics.turns_ended, 1);
    assert.equal(result.a.gaps.unclosed_turns, 0);
    expectConsistentTurns(result.a);
  });

  it('turns: compaction inside a turn does not close it; synthetic traces are skipped', () => {
    const file = writeSession(path.join(dir, 'dir-compaction'), 'ses-compaction', FIXTURE_COMPACTION);
    const result = runJson<CompareResult>(['--a', file, '--b', file]);
    const metrics = result.a.metrics;
    assert.equal(metrics.turns_started, 1);
    assert.equal(metrics.turns_ended, 1);
    assert.equal(metrics.turns_ended_by_api_error, 0);
    assert.equal(metrics.messages_mid_turn, 0);
    assert.equal(metrics.compactions, 1);
    assert.equal(metrics.tool_calls, 1); // the synthetic tool_use is not counted
    assert.equal(result.a.gaps.unclosed_turns, 0);
    assert.deepEqual(result.a.models, ['model-x']); // <synthetic> skipped
    assert.equal(result.a.gaps.incomplete_tool_calls, 0);
    expectConsistentTurns(result.a);
  });

  it('turns: interrupt in one line with a tool_result and in a separate line both close the turn as interrupted', () => {
    const file = writeSession(path.join(dir, 'dir-interrupts'), 'ses-interrupts', FIXTURE_INTERRUPTS);
    const result = runJson<CompareResult>(['--a', file, '--b', file]);
    const metrics = result.a.metrics;
    assert.equal(metrics.turns_interrupted, 2);
    assert.equal(metrics.turns_started, 2);
    assert.equal(metrics.turns_ended, 0);
    assert.equal(result.a.gaps.unclosed_turns, 0);
    // the result from the interrupt line is counted normally
    assert.deepEqual(result.a.tools.Bash, { calls: 2, failures: 0, incomplete: 1, measured: 1, total_ms: 1000, mean_ms: 1000 });
    expectConsistentTurns(result.a);
  });

  it('turns: file ending with an open turn gives unclosed_turns and an entry in unclosed_turn_list', () => {
    const file = writeSession(path.join(dir, 'dir-open'), 'ses-open', FIXTURE_OPEN);
    const result = runJson<CompareResult>(['--a', file, '--b', file]);
    assert.equal(result.a.gaps.unclosed_turns, 1);
    assert.deepEqual(result.a.gaps.unclosed_turn_list, [{ file, timestamp: at('09:40:00') }]);
    expectConsistentTurns(result.a);
  });

  it('server_tool_use deduplicated by id, advisor_tool_result separately by tool_use_id', () => {
    const file = writeSession(path.join(dir, 'dir-server'), 'ses-server', FIXTURE_SERVER);
    const result = runJson<CompareResult>(['--a', file, '--b', file]);
    const metrics = result.a.metrics;
    assert.equal(metrics.server_tool_use, 3); // duplicate id skipped; two without id counted by position
    assert.equal(metrics.advisor_tool_result, 2); // duplicate tool_use_id skipped; one without id counted by position
  });

  it('usage and read errors: exit 1', () => {
    const fileA1 = path.join(dir, 'dir-a', 'ses-a.jsonl');
    const fileB1 = path.join(dir, 'dir-b', 'ses-b.jsonl');
    const p1 = run(['--a', path.join(dir, 'missing.jsonl'), '--b', fileB1]);
    assert.equal(p1.status, 1);
    const p2 = run(['--a', fileA1]);
    assert.equal(p2.status, 1);
    const p3 = run(['--a', fileA1, '--b', fileB1, '--timeline', fileA1]);
    assert.equal(p3.status, 1);
    const p4 = run(['--a', fileA1, '--b', fileB1, '--time-threshold-pct', 'abc']);
    assert.equal(p4.status, 1);
    const p5 = run(['--unknown-option']);
    assert.equal(p5.status, 1);
    const bad = writeSession(path.join(dir, 'dir-bad'), 'ses-bad', ['this is not JSON', 'also not']);
    const p7 = run(['--a', bad, '--b', fileB1]);
    assert.equal(p7.status, 1);
    assert.match(p7.stderr, /valid line/);
    const p8 = run(['--help']);
    assert.equal(p8.status, 0);
    assert.match(p8.stdout, /Compare two/);
    const existing = path.join(dir, 'existing-result.json');
    fs.writeFileSync(existing, '{}\n');
    const p9 = run(['--a', fileA1, '--b', fileB1, '--output', existing]);
    assert.equal(p9.status, 1);
  });
});
