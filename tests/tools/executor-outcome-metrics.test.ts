import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, it } from 'vitest';

// Tests for tools/diagnostics/executor_outcome_metrics.py on synthetic transcripts. The script needs
// python3; the suite is skipped when python3 is not installed.
const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'tools',
  'diagnostics',
  'executor_outcome_metrics.py',
);
const hasPython3 = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;
if (!hasPython3) console.warn('executor-outcome-metrics tests skipped: python3 is not installed');

const MODEL = 'claude-test-model';
const at = (second: number) => new Date(Date.UTC(2026, 10, 14, 10, 0, second)).toISOString();

// one JSONL row; requestId is unique per row unless the extra fields override it
function row(type: 'assistant' | 'user', second: number, message: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, sessionId: 'sess-test', timestamp: at(second), requestId: `req-${second}`, message, ...extra });
}
function call(second: number, id: string, name: string, input: Record<string, unknown> = {}, model = MODEL): string {
  return row('assistant', second, { id: `msg-${id}`, model, content: [{ type: 'tool_use', id, name, input }] });
}
function result(second: number, id: string, content: unknown, isError?: boolean): string {
  const block: Record<string, unknown> = { type: 'tool_result', tool_use_id: id, content };
  if (isError !== undefined) block.is_error = isError;
  return row('user', second, { role: 'user', content: [block] });
}
function text(second: number, value: string): string {
  return row('assistant', second, { id: `msg-text-${second}`, model: MODEL, content: [{ type: 'text', text: value }] }, { isSidechain: false });
}
function apiError(second: number, value: string, error?: string): string {
  return row(
    'assistant',
    second,
    { id: `msg-api-${second}`, model: '<synthetic>', content: [{ type: 'text', text: value }] },
    { isApiErrorMessage: true, isSidechain: false, ...(error ? { error } : {}) },
  );
}

let dir = '';
let counter = 0;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-executor-metrics-'));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(lines: string[], name = `transcript-${++counter}.jsonl`): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}
function run(args: string[]) {
  return spawnSync('python3', ['-I', SCRIPT, ...args], { encoding: 'utf8' });
}
interface OscillationPattern {
  first: number;
  last: number;
  cycle: string[];
  cycle_count: number;
}
interface Task {
  session_id: string;
  provider: string;
  model: string | null;
  parent: string | null;
  transcript: string;
  bad_lines: number;
  metrics: Record<string, unknown>;
  reasons: Record<string, string>;
  final_result: { status: string; flags: string[]; reason?: string };
  loop_patterns: { retry: number[][]; parameter_drift: number[][]; oscillation: OscillationPattern[] };
}
interface Output {
  tasks: Task[];
  coverage: Record<string, unknown>;
  skipped: Array<{ kind: string }>;
}
// one transcript, JSON output, exactly one task
function taskOf(lines: string[], extra: string[] = []): Task {
  const p = run(['--transcript', write(lines), '--json', ...extra]);
  assert.equal(p.status, 0, `exit ${p.status}: ${p.stderr}`);
  const out = JSON.parse(p.stdout) as Output;
  assert.equal(out.tasks.length, 1);
  return out.tasks[0];
}
// calls the python module functions directly (isolated mode, the module directory is put on the path)
function pyEval(expression: string): unknown {
  const code = `import json, sys; sys.path.insert(0, ${JSON.stringify(path.dirname(SCRIPT))}); sys.dont_write_bytecode = True; `
    + `import executor_outcome_metrics as m; print(json.dumps(${expression}))`;
  const p = spawnSync('python3', ['-I', '-c', code], { encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
  return JSON.parse(p.stdout);
}
// calls with distinct inputs (no retry, no drift): read-only file reads
function readCalls(count: number): string[] {
  return Array.from({ length: count }, (_, i) => call(i + 1, `r${i}`, 'Read', { file_path: `/f${i}` }));
}

describe.skipIf(!hasPython3)('executor_outcome_metrics.py', () => {
  describe('detector 1: failed tool results', () => {
    it('an empty result is not a failure; only an explicit is_error flag counts', () => {
      const task = taskOf([
        call(1, 'a', 'Bash', { command: 'x' }), result(2, 'a', ''),
        call(3, 'b', 'Bash', { command: 'y' }), result(4, 'b', 'Error: boom', true),
        call(5, 'c', 'Read', { file_path: '/a' }), result(6, 'c', 'error word but no flag', false),
      ]);
      assert.equal(task.metrics.tool_failures, 1);
      assert.equal(task.metrics.failure_runs, 0);
    });

    it('runs of two or more failures are counted with the longest run', () => {
      const task = taskOf([
        call(1, 'a', 'Read', { file_path: '/1' }), result(2, 'a', 'Error', true),
        call(3, 'b', 'Read', { file_path: '/2' }), result(4, 'b', 'Error', true),
        call(5, 'c', 'Read', { file_path: '/3' }), result(6, 'c', 'ok', false),
        call(7, 'd', 'Read', { file_path: '/4' }), result(8, 'd', 'Error', true),
        call(9, 'e', 'Read', { file_path: '/5' }), result(10, 'e', 'Error', true),
        call(11, 'f', 'Read', { file_path: '/6' }), result(12, 'f', 'Error', true),
      ]);
      assert.equal(task.metrics.tool_failures, 5);
      assert.equal(task.metrics.failure_runs, 2);
      assert.equal(task.metrics.longest_failure_run, 3);
    });
  });

  describe('detectors 2-4: loop patterns', () => {
    it('retry: two identical calls are below the threshold', () => {
      const task = taskOf([call(1, 'a', 'Grep', { pattern: 'x' }), call(2, 'b', 'Grep', { pattern: 'x' })]);
      assert.equal(task.metrics.retry_patterns, 0);
      assert.deepEqual(task.loop_patterns.retry, []);
    });

    it('retry: three identical calls form one pattern with first and last index; four form one too', () => {
      const three = taskOf([
        call(1, 'a', 'Grep', { pattern: 'x' }), call(2, 'b', 'Grep', { pattern: 'x' }), call(3, 'c', 'Grep', { pattern: 'x' }),
      ]);
      assert.equal(three.metrics.retry_patterns, 1);
      assert.deepEqual(three.loop_patterns.retry, [[0, 2]]);
      const four = taskOf([
        call(1, 'a', 'Grep', { pattern: 'x' }), call(2, 'b', 'Grep', { pattern: 'x' }),
        call(3, 'c', 'Grep', { pattern: 'x' }), call(4, 'd', 'Grep', { pattern: 'x' }),
      ]);
      assert.equal(four.metrics.retry_patterns, 1);
      assert.deepEqual(four.loop_patterns.retry, [[0, 3]]);
    });

    it('retry: argument key order does not change the signature', () => {
      const task = taskOf([
        call(1, 'a', 'Edit', { a: 1, b: 2 }), call(2, 'b', 'Edit', { b: 2, a: 1 }), call(3, 'c', 'Edit', { a: 1, b: 2 }),
      ]);
      assert.deepEqual(task.loop_patterns.retry, [[0, 2]]);
    });

    it('parameter drift: two calls to one tool with two signatures are below the threshold', () => {
      const task = taskOf([call(1, 'a', 'Write', { file_path: 'x', content: '1' }), call(2, 'b', 'Write', { file_path: 'x', content: '2' })]);
      assert.equal(task.metrics.parameter_drift_patterns, 0);
    });

    it('parameter drift: three calls to one tool with two signatures form one pattern', () => {
      const task = taskOf([
        call(1, 'a', 'Write', { file_path: 'x', content: '1' }),
        call(2, 'b', 'Write', { file_path: 'x', content: '1' }),
        call(3, 'c', 'Write', { file_path: 'x', content: '2' }),
      ]);
      assert.equal(task.metrics.parameter_drift_patterns, 1);
      assert.deepEqual(task.loop_patterns.parameter_drift, [[0, 2]]);
      assert.equal(task.metrics.retry_patterns, 0);
    });

    it('parameter drift: four calls to one tool with two signatures are still one pattern', () => {
      const task = taskOf([
        call(1, 'a', 'Write', { file_path: 'x', content: '1' }),
        call(2, 'b', 'Write', { file_path: 'x', content: '2' }),
        call(3, 'c', 'Write', { file_path: 'x', content: '3' }),
        call(4, 'd', 'Write', { file_path: 'x', content: '4' }),
      ]);
      assert.equal(task.metrics.parameter_drift_patterns, 1);
      assert.deepEqual(task.loop_patterns.parameter_drift, [[0, 3]]);
    });

    it('parameter drift: a drift run that overlaps a retry run is suppressed', () => {
      const task = taskOf([
        call(1, 'a', 'Bash', { command: 'make' }),
        call(2, 'b', 'Bash', { command: 'make' }),
        call(3, 'c', 'Bash', { command: 'make' }),
        call(4, 'd', 'Bash', { command: 'make clean' }),
      ]);
      assert.equal(task.metrics.retry_patterns, 1);
      assert.equal(task.metrics.parameter_drift_patterns, 0);
    });

    it('oscillation: two full repeats of a two-name cycle are below the threshold', () => {
      const task = taskOf([
        call(1, 'a', 'Read', { file_path: '1' }), call(2, 'b', 'Grep', { pattern: '1' }),
        call(3, 'c', 'Read', { file_path: '2' }), call(4, 'd', 'Grep', { pattern: '2' }),
      ]);
      assert.equal(task.metrics.oscillation_patterns, 0);
    });

    it('oscillation: three full repeats of a two-name cycle form one pattern with the cycle and its count', () => {
      const task = taskOf([
        call(1, 'a', 'Read', { file_path: '1' }), call(2, 'b', 'Grep', { pattern: '1' }),
        call(3, 'c', 'Read', { file_path: '2' }), call(4, 'd', 'Grep', { pattern: '2' }),
        call(5, 'e', 'Read', { file_path: '3' }), call(6, 'f', 'Grep', { pattern: '3' }),
      ]);
      assert.equal(task.metrics.oscillation_patterns, 1);
      assert.deepEqual(task.loop_patterns.oscillation, [{ first: 0, last: 5, cycle: ['Read', 'Grep'], cycle_count: 3 }]);
    });

    it('oscillation: four full repeats of a two-name cycle are one pattern with the cycle count 4', () => {
      const calls = Array.from({ length: 8 }, (_, i) =>
        i % 2 === 0 ? call(i + 1, `c${i}`, 'Read', { file_path: String(i) }) : call(i + 1, `c${i}`, 'Grep', { pattern: String(i) }));
      const task = taskOf(calls);
      assert.equal(task.metrics.oscillation_patterns, 1);
      assert.deepEqual(task.loop_patterns.oscillation, [{ first: 0, last: 7, cycle: ['Read', 'Grep'], cycle_count: 4 }]);
    });

    it('oscillation: a cycle of five names repeated three times is found, a cycle of six names is not', () => {
      const names = ['Read', 'Grep', 'Bash', 'Edit', 'Write', 'Glob'];
      const build = (length: number) =>
        Array.from({ length: length * 3 }, (_, i) => call(i + 1, `c${i}`, names[i % length], { n: i }));
      const five = taskOf(build(5));
      assert.equal(five.metrics.oscillation_patterns, 1);
      assert.equal(five.loop_patterns.oscillation[0].cycle.length, 5);
      assert.equal(taskOf(build(6)).metrics.oscillation_patterns, 0);
    });

    it('overlap removal: the longest pattern from an equal start is kept and a nested pattern is dropped', () => {
      const kept = pyEval(
        'm.remove_overlaps([{"first": 0, "last": 3}, {"first": 0, "last": 7}, {"first": 2, "last": 5}, {"first": 8, "last": 9}])',
      );
      assert.deepEqual(kept, [{ first: 0, last: 7 }, { first: 8, last: 9 }]);
    });

    it('oscillation: a three-name cycle repeated three times is one pattern', () => {
      const task = taskOf([
        call(1, 'a', 'Read', { file_path: '1' }), call(2, 'b', 'Grep', { pattern: '1' }), call(3, 'c', 'Bash', { command: '1' }),
        call(4, 'd', 'Read', { file_path: '2' }), call(5, 'e', 'Grep', { pattern: '2' }), call(6, 'f', 'Bash', { command: '2' }),
        call(7, 'g', 'Read', { file_path: '3' }), call(8, 'h', 'Grep', { pattern: '3' }), call(9, 'i', 'Bash', { command: '3' }),
      ]);
      assert.equal(task.metrics.oscillation_patterns, 1);
      assert.equal(task.loop_patterns.oscillation[0].cycle.length, 3);
    });

    it('oscillation: a single-name cycle is not oscillation', () => {
      const task = taskOf(readCalls(6));
      assert.equal(task.metrics.oscillation_patterns, 0);
    });

    it('fewer calls than the thresholds give no patterns', () => {
      const task = taskOf(readCalls(2));
      assert.equal(task.metrics.retry_patterns, 0);
      assert.equal(task.metrics.parameter_drift_patterns, 0);
      assert.equal(task.metrics.oscillation_patterns, 0);
    });
  });

  describe('threshold options', () => {
    const twoSame = [call(1, 'a', 'Grep', { pattern: 'x' }), call(2, 'b', 'Grep', { pattern: 'x' })];
    const twoDrift = [call(1, 'a', 'Write', { content: '1' }), call(2, 'b', 'Write', { content: '2' })];
    const twoRepeats = [
      call(1, 'a', 'Read', { n: 1 }), call(2, 'b', 'Grep', { n: 1 }),
      call(3, 'c', 'Read', { n: 2 }), call(4, 'd', 'Grep', { n: 2 }),
    ];

    it('without the options the defaults apply and two-call patterns are not reported', () => {
      assert.equal(taskOf(twoSame).metrics.retry_patterns, 0);
      assert.equal(taskOf(twoDrift).metrics.parameter_drift_patterns, 0);
      assert.equal(taskOf(twoRepeats).metrics.oscillation_patterns, 0);
    });

    it('--retry-threshold lowers the retry threshold', () => {
      assert.deepEqual(taskOf(twoSame, ['--retry-threshold', '2']).loop_patterns.retry, [[0, 1]]);
    });

    it('--drift-threshold lowers the drift threshold', () => {
      assert.deepEqual(taskOf(twoDrift, ['--drift-threshold', '2']).loop_patterns.parameter_drift, [[0, 1]]);
    });

    it('--drift-min-signatures raises the number of distinct signatures a drift run needs', () => {
      const three = [
        call(1, 'a', 'Write', { content: '1' }), call(2, 'b', 'Write', { content: '1' }), call(3, 'c', 'Write', { content: '2' }),
      ];
      assert.equal(taskOf(three).metrics.parameter_drift_patterns, 1);
      assert.equal(taskOf(three, ['--drift-min-signatures', '3']).metrics.parameter_drift_patterns, 0);
    });

    it('--oscillation-min-repeats lowers the repeat threshold', () => {
      assert.equal(taskOf(twoRepeats, ['--oscillation-min-repeats', '2']).metrics.oscillation_patterns, 1);
    });

    it('--max-cycle-length raises the longest cycle that is checked', () => {
      const names = ['Read', 'Grep', 'Bash', 'Edit', 'Write', 'Glob'];
      const calls = Array.from({ length: 18 }, (_, i) => call(i + 1, `c${i}`, names[i % 6], { n: i }));
      assert.equal(taskOf(calls).metrics.oscillation_patterns, 0);
      assert.equal(taskOf(calls, ['--max-cycle-length', '6']).metrics.oscillation_patterns, 1);
    });

    it('loop_patterns takes its thresholds as parameters', () => {
      const calls = '[{"name": "A", "signature": "A(1)"}, {"name": "A", "signature": "A(1)"}]';
      assert.deepEqual(pyEval(`m.loop_patterns(${calls})["retry"]`), []);
      assert.deepEqual(pyEval(`m.loop_patterns(${calls}, retry_threshold=2)["retry"]`), [[0, 1]]);
    });
  });

  describe('detector 7: flags of the final answer', () => {
    it('empty: blank text after trimming', () => {
      const task = taskOf([text(1, '   ')]);
      assert.deepEqual(task.final_result.flags, ['empty']);
    });

    it('cut_off: a dangling colon, a dangling return keyword; a complete sentence is not flagged', () => {
      assert.deepEqual(taskOf([text(1, 'Result:')]).final_result.flags, ['cut_off']);
      assert.deepEqual(taskOf([text(1, 'function f() {\n  return')]).final_result.flags, ['cut_off']);
      assert.deepEqual(taskOf([text(1, 'Done.')]).final_result.flags, []);
    });

    it('odd_fences: an odd number of triple-backtick markers; an even number is not flagged', () => {
      assert.deepEqual(taskOf([text(1, '```js\nconst a = 1;')]).final_result.flags, ['odd_fences']);
      assert.deepEqual(taskOf([text(1, '```\nx\n```')]).final_result.flags, []);
    });

    it('repeated_line: one line longer than 8 characters five times in a row; blank lines are ignored', () => {
      assert.deepEqual(taskOf([text(1, 'same line of text\n'.repeat(5).trimEnd())]).final_result.flags, ['repeated_line']);
      assert.deepEqual(taskOf([text(1, 'same line of text\n\n'.repeat(5).trimEnd())]).final_result.flags, ['repeated_line']);
      assert.deepEqual(taskOf([text(1, 'same line of text\n'.repeat(4).trimEnd())]).final_result.flags, []);
      assert.deepEqual(taskOf([text(1, 'abcdefgh\n'.repeat(5).trimEnd())]).final_result.flags, []);
    });

    it('ended_with_api_error and the other flags combine in the fixed order', () => {
      const task = taskOf([
        text(1, `Output:\n${'repeated line here\n'.repeat(5)}const`),
        apiError(2, 'API Error: Request rejected (429)', 'rate_limit'),
      ]);
      assert.deepEqual(task.final_result.flags, ['cut_off', 'repeated_line', 'ended_with_api_error']);
    });

    it('no main-thread text gives an unmeasured final answer with a reason', () => {
      const task = taskOf(readCalls(1));
      assert.equal(task.final_result.status, 'unmeasured');
      assert.equal(task.final_result.reason, 'no main-thread text block');
    });
  });

  describe('detector 5: resource exhaustion', () => {
    const apiLines = [
      text(0, 'Working.'),
      apiError(1, 'API Error: Request rejected (429) · limit', 'rate_limit'),
      apiError(2, 'Upstream failure', 'overloaded'),
      apiError(3, 'Invalid request', 'invalid_request'),
    ];

    it('API errors: status from the text, status from the configured error field mapping, and an other error', () => {
      const task = taskOf(apiLines, ['--error-field-status', 'overloaded=529']);
      assert.equal(task.metrics.exhaustion_api, 2);
      assert.deepEqual(task.metrics.exhaustion_api_by_status, { '429': 1, '529': 1 });
      assert.equal(task.metrics.api_errors_other, 1);
      assert.deepEqual(task.metrics.api_errors_by_error_field, { rate_limit: 1, overloaded: 1, invalid_request: 1 });
    });

    it('API errors: without an error field mapping only the status in the text counts', () => {
      const task = taskOf(apiLines);
      assert.equal(task.metrics.exhaustion_api, 1);
      assert.deepEqual(task.metrics.exhaustion_api_by_status, { '429': 1 });
      assert.equal(task.metrics.api_errors_other, 2);
    });

    it('--exhaustion-status and --exhaustion-phrase extend the built-in sets', () => {
      const lines = [
        text(0, 'Working.'),
        apiError(1, 'Server error (500)'),
        apiError(2, 'Quota depleted for this key'),
      ];
      assert.equal(taskOf(lines).metrics.exhaustion_api, 0);
      const task = taskOf(lines, ['--exhaustion-status', '500', '--exhaustion-phrase', 'Quota Depleted']);
      assert.equal(task.metrics.exhaustion_api, 2);
      assert.deepEqual(task.metrics.exhaustion_api_by_status, { '500': 1, phrase: 1 });
    });

    it('the exhaustion functions take the status and phrase sets as parameters', () => {
      assert.equal(pyEval('m.exhaustion_key("boom", 418, statuses=(418,))'), '418');
      assert.equal(pyEval('m.exhaustion_key("boom", 418)'), null);
      assert.equal(pyEval('m.exhaustion_key("disk full", None, phrases=("disk full",))'), 'phrase');
      assert.equal(pyEval('m.exhaustion_key("disk full", None)'), null);
    });

    it('API error with a phrase and no status counts under the phrase key', () => {
      const task = taskOf([text(0, 'Working.'), apiError(1, 'Request failed: context window exceeded')]);
      assert.equal(task.metrics.exhaustion_api, 1);
      assert.deepEqual(task.metrics.exhaustion_api_by_status, { phrase: 1 });
    });

    it('unknown text and no error field is other', () => {
      const task = taskOf([text(0, 'Working.'), apiError(1, 'Something odd happened')]);
      assert.equal(task.metrics.exhaustion_api, 0);
      assert.equal(task.metrics.api_errors_other, 1);
    });

    it('a failed tool result counts by phrase, and by a status in the set', () => {
      const task = taskOf([
        call(1, 'a', 'Read', { file_path: '/a' }), result(2, 'a', 'Error: context window exceeded', true),
        call(3, 'b', 'Read', { file_path: '/b' }), result(4, 'b', 'Error: request failed (503)', true),
      ]);
      assert.equal(task.metrics.exhaustion_tool_results, 2);
    });

    it('a status outside the set in a failed result is not exhaustion', () => {
      const task = taskOf([call(1, 'a', 'Read', { file_path: '/a' }), result(2, 'a', 'Error: failed (500)', true)]);
      assert.equal(task.metrics.exhaustion_tool_results, 0);
    });

    it('a non-failed result containing a phrase does not count', () => {
      const task = taskOf([
        call(1, 'a', 'Read', { file_path: '/a' }), result(2, 'a', 'rate limit notes, no failure', false),
        call(3, 'b', 'Read', { file_path: '/b' }), result(4, 'b', 'timeout mentioned, no flag'),
      ]);
      assert.equal(task.metrics.exhaustion_tool_results, 0);
    });
  });

  describe('assistant steps, thinking and tokens', () => {
    it('synthetic rows are not steps or tokens; a repeated message id is one step; tokens take the maximum', () => {
      const task = taskOf([
        row('assistant', 1, { id: 'm1', model: MODEL, usage: { output_tokens: 10 }, content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'Looking.' }] }, { requestId: 'r1', thinkingDurationMs: 400 }),
        row('assistant', 2, { id: 'm1', model: MODEL, usage: { output_tokens: 25 }, content: [{ type: 'text', text: 'More.' }] }, { requestId: 'r1', thinkingDurationMs: 100 }),
        row('assistant', 3, { id: 'm2', model: '<synthetic>', usage: { output_tokens: 99 }, content: [{ type: 'text', text: 'Compacted.' }] }),
      ]);
      assert.equal(task.metrics.assistant_steps, 1);
      assert.equal(task.metrics.output_tokens, 25);
      assert.equal(task.metrics.thinking_blocks, 1);
      assert.equal(task.metrics.thinking_duration_ms, 500);
      assert.equal(task.metrics.thinking_chars, 'unmeasured');
      assert.equal(task.reasons.thinking_chars, 'thinking text hidden or empty');
    });

    it('missing fields are unmeasured with a reason, never zero', () => {
      const task = taskOf([text(1, 'Done.')]);
      assert.equal(task.metrics.thinking_blocks, 0);
      assert.equal(task.reasons.thinking_chars, 'no thinking blocks');
      assert.equal(task.metrics.thinking_duration_ms, 'unmeasured');
      assert.equal(task.reasons.thinking_duration_ms, 'no thinkingDurationMs field');
      assert.equal(task.metrics.output_tokens, 'unmeasured');
      assert.equal(task.reasons.output_tokens, 'no usage.output_tokens field');
    });
  });

  describe('test runs and advisor consultations', () => {
    const failed = (second: number, id: string, command: string) => [
      call(second, id, 'Bash', { command }),
      result(second + 1, id, 'Error: tests failed', true),
    ];
    const advisor = (second: number) => row('assistant', second, {
      id: `msg-adv-${second}`,
      model: MODEL,
      content: [{ type: 'server_tool_use', name: 'advisor', input: {} }],
    });

    it('two failed runs closed by an advisor consultation make one episode; one failure does not; a run open at the end counts', () => {
      const closed = taskOf([...failed(1, 'a', 'npm test'), ...failed(3, 'b', 'npm test'), advisor(5)]);
      assert.equal(closed.metrics.test_episodes_without_advisor, 1);
      assert.equal(closed.metrics.test_runs_failed, 2);
      assert.equal(closed.metrics.advisor_consultations, 1);
      const single = taskOf([...failed(1, 'a', 'npm test'), advisor(3), ...failed(5, 'b', 'npm test')]);
      assert.equal(single.metrics.test_episodes_without_advisor, 0);
      const open = taskOf([...failed(1, 'a', 'npm test'), ...failed(3, 'b', 'npm test')]);
      assert.equal(open.metrics.test_episodes_without_advisor, 1);
    });

    it('three failed runs closed by a passed run make one episode', () => {
      const task = taskOf([
        ...failed(1, 'a', 'npm test'), ...failed(3, 'b', 'npm test'), ...failed(5, 'c', 'npm test'),
        call(7, 'd', 'Bash', { command: 'npm test' }), result(8, 'd', 'pass', false),
      ]);
      assert.equal(task.metrics.test_episodes_without_advisor, 1);
      assert.equal(task.metrics.test_runs_failed, 3);
      assert.equal(task.metrics.test_runs_passed, 1);
    });

    it('a test run without a result neither counts as failed or passed nor breaks a series', () => {
      const task = taskOf([
        ...failed(1, 'a', 'npm test'),
        call(3, 'b', 'Bash', { command: 'npm test' }),
        ...failed(5, 'c', 'npm test'),
      ]);
      assert.equal(task.metrics.test_runs_no_result, 1);
      assert.equal(task.metrics.test_runs_failed, 2);
      assert.equal(task.metrics.test_episodes_without_advisor, 1);
    });

    it('commands that only mention test files are not test runs', () => {
      const task = taskOf([
        call(1, 'a', 'Bash', { command: 'cat tests/unit.txt' }), result(2, 'a', 'Error', true),
        call(3, 'b', 'Bash', { command: 'ls tests/' }), result(4, 'b', 'Error', true),
        call(5, 'c', 'Bash', { command: 'git add tests/a.ts' }), result(6, 'c', 'Error', true),
      ]);
      assert.equal(task.metrics.test_runs_failed, 0);
      assert.equal(task.metrics.test_episodes_without_advisor, 0);
    });

    it('--test-pattern replaces the built-in list of test runners', () => {
      const lines = [...failed(1, 'a', 'npm test'), ...failed(3, 'b', 'make check'), ...failed(5, 'c', 'make check')];
      const task = taskOf(lines, ['--test-pattern', 'make check']);
      assert.equal(task.metrics.test_runs_failed, 2);
      assert.equal(task.metrics.test_episodes_without_advisor, 1);
    });

    it('--advisor-pattern counts a Bash consultation; without it the same command is not one', () => {
      const lines = [call(1, 'a', 'Bash', { command: 'consult-tool --q x' }), result(2, 'a', 'answer', false)];
      assert.equal(taskOf(lines, ['--advisor-pattern', 'consult-tool']).metrics.advisor_consultations, 1);
      assert.equal(taskOf(lines).metrics.advisor_consultations, 0);
    });
  });

  describe('input handling and options', () => {
    it('provider comes from the model prefix through --provider-map; the context suffix is removed', () => {
      const lines = [text(1, 'Done.')].map((l) => l.replace(MODEL, 'model-x-1[1m]'));
      const mapped = taskOf(lines, ['--provider-map', 'model-x=provider-x']);
      assert.equal(mapped.provider, 'provider-x');
      assert.equal(mapped.model, 'model-x-1');
      assert.equal(taskOf(lines).provider, 'unmapped');
    });

    it('a subagent file is a separate task with its parent session', () => {
      const sessionDir = path.join(dir, 'parent-session');
      fs.mkdirSync(path.join(sessionDir, 'subagents'), { recursive: true });
      const agent = path.join(sessionDir, 'subagents', 'agent-x.jsonl');
      fs.writeFileSync(agent, [text(1, 'Subagent done.')].join('\n') + '\n');
      const out = JSON.parse(run(['--transcript', agent, '--json']).stdout);
      assert.equal(out.tasks[0].session_id, 'agent-x');
      assert.equal(out.tasks[0].parent, 'sess-test');
    });

    it('a subagent file is judged on its own thread: sidechain rows give the final answer, in a main file they do not', () => {
      const sidechainText = (second: number, value: string) =>
        row('assistant', second, { id: `msg-side-${second}`, model: MODEL, content: [{ type: 'text', text: value }] }, { isSidechain: true });
      const sessionDir = path.join(dir, 'sidechain-session');
      fs.mkdirSync(path.join(sessionDir, 'subagents'), { recursive: true });
      const agent = path.join(sessionDir, 'subagents', 'agent-side.jsonl');
      const sidechainError = row('assistant', 2, { id: 'msg-side-err', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: Request rejected (529)' }] }, { isApiErrorMessage: true, isSidechain: true });
      fs.writeFileSync(agent, [sidechainText(1, 'The answer is, '), sidechainError].join('\n') + '\n');
      const worker = JSON.parse(run(['--transcript', agent, '--json']).stdout).tasks[0];
      assert.equal(worker.final_result.status, 'measured');
      assert.deepEqual(worker.final_result.flags, ['cut_off', 'ended_with_api_error']);
      // the same rows in a main transcript are another thread's work: no main-thread text
      const main = taskOf([sidechainText(1, 'The answer is, ')]);
      assert.equal(main.final_result.status, 'unmeasured');
    });

    it('rows whose message is not an object are skipped without ending the run', () => {
      const malformed = ['"text"', '7', '[1, 2]'].flatMap((message) => [
        `{"type":"assistant","timestamp":"${at(0)}","message":${message}}`,
        `{"type":"user","timestamp":"${at(0)}","message":${message}}`,
      ]);
      const task = taskOf([...malformed, text(1, 'Done.')]);
      assert.equal(task.transcript, 'present');
      assert.equal(task.metrics.assistant_steps, 1);
    });

    it('a transcript with only API error rows keeps its exhaustion measurement', () => {
      const prompt = row('user', 0, { role: 'user', content: 'Do the task.' }, { isSidechain: false });
      const task = taskOf([prompt, apiError(1, 'API Error: Request rejected (429)', 'rate_limit')]);
      assert.equal(task.transcript, 'present');
      assert.equal(task.metrics.exhaustion_api, 1);
      assert.deepEqual(task.metrics.exhaustion_api_by_status, { '429': 1 });
      assert.equal(task.metrics.assistant_steps, 0);
      assert.equal(task.final_result.status, 'unmeasured');
    });

    it('the same file given twice is skipped and reported', () => {
      const file = write([text(1, 'Done.')]);
      const out = JSON.parse(run(['--transcript', file, '--transcript', file, '--json']).stdout);
      assert.equal(out.tasks.length, 1);
      assert.equal(out.skipped[0].kind, 'duplicate-file');
    });

    it('bad JSON lines are counted; api-request-blob rows are not read', () => {
      const blob = JSON.stringify({ type: 'api-request-blob', sessionId: 'sess-test', message: { content: [{ type: 'tool_use', id: 'blob', name: 'Bash', input: { command: 'x' } }] } });
      const task = taskOf([blob, 'this is not JSON', text(1, 'Done.')]);
      assert.equal(task.bad_lines, 1);
      assert.equal(task.metrics.assistant_steps, 1);
      assert.equal(task.metrics.test_runs_no_result, 0);
    });

    it('an unreadable file gives an unmeasured task with a reason and exit code 0', () => {
      const p = run(['--transcript', '/proc/self/mem', '--json']);
      assert.equal(p.status, 0, p.stderr);
      const task = JSON.parse(p.stdout).tasks[0];
      assert.equal(task.transcript, 'unreadable');
      assert.equal(task.metrics.assistant_steps, 'unmeasured');
      assert.equal(task.reasons.assistant_steps, 'transcript unreadable');
    });

    it('date filter: tasks outside the range are dropped; tasks without a date are counted as no_date', () => {
      const file = write([text(1, 'Done.')]);
      const inside = JSON.parse(run(['--transcript', file, '--from', '2026-11-14', '--to', '2026-11-14', '--json']).stdout);
      assert.equal(inside.coverage.total, 1);
      const outside = JSON.parse(run(['--transcript', file, '--from', '2026-11-15', '--json']).stdout);
      assert.equal(outside.coverage.total, 0);
      const undated = write([JSON.stringify({ type: 'assistant', sessionId: 'sess-test', message: { id: 'm', model: MODEL, content: [{ type: 'text', text: 'Done.' }] } })]);
      const noDate = JSON.parse(run(['--transcript', undated, '--from', '2026-11-15', '--json']).stdout);
      assert.deepEqual(noDate.coverage, { with_transcript: 0, total: 0, percent: '0.0', no_date: 1 });
    });

    it('text output shows coverage and the provider summary', () => {
      const file = write([text(1, 'Done.')]);
      const p = run(['--transcript', file, '--provider-map', 'claude-=anthropic']);
      assert.equal(p.status, 0, p.stderr);
      assert.ok(!p.stdout.startsWith('{'));
      assert.ok(p.stdout.includes('coverage: 1/1 tasks with transcript (100.0%)'));
      assert.ok(p.stdout.includes('summary provider=anthropic'));
    });

    it('usage errors exit with code 2', () => {
      const file = write([text(1, 'Done.')]);
      assert.equal(run([]).status, 2);
      assert.equal(run(['--transcript', path.join(dir, 'missing.jsonl')]).status, 2);
      assert.equal(run(['--transcript', file, '--from', '14-11-2026']).status, 2);
      assert.equal(run(['--transcript', file, '--from', '2026-11-15', '--to', '2026-11-14']).status, 2);
      assert.equal(run(['--transcript', file, '--provider-map', 'model-x-']).status, 2);
      assert.equal(run(['--transcript', file, '--retry-threshold', '0']).status, 2);
      assert.equal(run(['--transcript', file, '--max-cycle-length', '1']).status, 2);
      assert.equal(run(['--transcript', file, '--error-field-status', 'overloaded']).status, 2);
      assert.equal(run(['--transcript', file, '--error-field-status', 'overloaded=abc']).status, 2);
      assert.equal(run(['--transcript', file, '--test-pattern', '(bad']).status, 2);
    });
  });
});
