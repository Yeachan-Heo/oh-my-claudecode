import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every refusal with exit code 2 that is about a file or a directory names that path, so that a run over many inputs
// says which one it stopped at. Each case is a valid run with one option pointed at a path that cannot be used.
// Messages that are not about a path (a bad time, a bad number, a missing option) are not listed, and neither are the
// refusals to overwrite an output file of the tools whose documented exit code for it is 1 (their message names the path too).

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'tools');
const TOOLS = join(ROOT, 'diagnostics');
const hasPython3 = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;

let base = '';
let projects = '';
let compact = '';
let journal = '';
let missing = '';
let directory = '';
let existing = '';
let notJson = '';
let emptyObject = '';
let emptyFile = '';

const ROW_USER = { type: 'user', timestamp: '2026-11-14T10:00:00.000Z', sessionId: 's1', message: { role: 'user', content: 'hello' } };
const ROW_ASSISTANT = {
  type: 'assistant', timestamp: '2026-11-14T10:00:01.000Z', sessionId: 's1', requestId: 'r1',
  message: { id: 'm1', model: 'claude-test', role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1, output_tokens: 1 } },
};

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'exit-code-2-'));
  projects = join(base, 'projects');
  mkdirSync(join(projects, 'proj'), { recursive: true });
  writeFileSync(join(projects, 'proj', 's1.jsonl'), `${JSON.stringify(ROW_USER)}\n${JSON.stringify(ROW_ASSISTANT)}\n`);
  compact = join(base, 'compact.jsonl');
  writeFileSync(compact, '');
  journal = join(base, 'journal');
  mkdirSync(journal);
  writeFileSync(join(journal, 'applied.jsonl'), `${JSON.stringify({ ts: '2026-11-14T10:00:00.500Z', point: 'learner-extraction', session_id: 's1', applied: {} })}\n`);
  missing = join(base, 'no-such-path');
  directory = join(base, 'a-directory');
  mkdirSync(directory);
  existing = join(base, 'existing-output.json');
  writeFileSync(existing, '{}');
  notJson = join(base, 'not-json.json');
  writeFileSync(notJson, '{nope');
  emptyObject = join(base, 'empty-object.json');
  writeFileSync(emptyObject, '{}');
  emptyFile = join(base, 'empty.tsv');
  writeFileSync(emptyFile, '');
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

type Args = string[];
// A valid run of each tool over the small tree above.
const BASE: Record<string, () => Args> = {
  'advisor_event_coverage.py': () => ['--projects', projects, '--label', 'x'],
  'compaction_harm_monitor.py': () => ['--projects', projects, '--compact', compact, '--to', '2026-11-15T00:00:00Z', '--days', '7'],
  'user_prohibitions_after_compaction.py': () => ['--projects', projects],
  'compaction_cache_cost.py': () => ['--projects', projects, '--compact', compact, '--deployed-at', '2026-11-01T00:00:00Z', '--to', '2026-11-15T00:00:00Z', '--days', '30', '--json'],
  'compaction_ask_probe.py': () => ['--projects', projects, '--compact', compact, '--json'],
  'compaction_window_drops.py': () => ['--projects', projects, '--compact', compact],
  'empty_results.py': () => ['--transcripts', projects],
  'tool_call_repeats.py': () => ['--transcripts', projects],
  'decision_outcome_join.py': () => ['--journal', journal, '--transcripts', projects],
  'executor_outcome_metrics.py': () => ['--transcript', join(projects, 'proj', 's1.jsonl')],
  'jev_outcome_labels.mjs': () => ['--journal', journal, '--transcripts', projects, '--json'],
  'hook_latency_p95.mjs': () => ['--dir', base],
  'denial_log_summary.mjs': () => ['--dir', base],
  'wilson_threshold.mjs': () => ['--input', emptyFile, '--target', '0.9'],
  'worktree_report.mjs': () => ['--repo', base],
};

function withOption(args: Args, option: string, value: string): Args {
  const copy = [...args];
  const at = copy.indexOf(option);
  if (at >= 0) copy[at + 1] = value;
  else copy.push(option, value);
  return copy;
}

// [tool, option that is pointed at the path, path]. The path is a function: it is made in beforeAll.
const CASES: Array<[string, string, () => string]> = [
  ['advisor_event_coverage.py', '--projects', () => missing],
  ['advisor_event_coverage.py', '--projects', () => existing],
  ['advisor_event_coverage.py', '--out', () => existing],
  ['advisor_event_coverage.py', '--sessions-out', () => existing],
  ['compaction_harm_monitor.py', '--compact', () => directory],
  ['compaction_harm_monitor.py', '--compact', () => missing],
  ['compaction_harm_monitor.py', '--probe', () => missing],
  ['compaction_harm_monitor.py', '--probe', () => notJson],
  ['compaction_harm_monitor.py', '--probe', () => emptyObject],
  ['user_prohibitions_after_compaction.py', '--projects', () => missing],
  ['user_prohibitions_after_compaction.py', '--projects', () => existing],
  ['user_prohibitions_after_compaction.py', '--compact-log', () => directory],
  ['user_prohibitions_after_compaction.py', '--compact-log', () => missing],
  ['user_prohibitions_after_compaction.py', '--out', () => existing],
  ['user_prohibitions_after_compaction.py', '--locators', () => existing],
  ['user_prohibitions_after_compaction.py', '--patterns', () => missing],
  ['user_prohibitions_after_compaction.py', '--patterns', () => directory],
  ['user_prohibitions_after_compaction.py', '--patterns', () => notJson],
  ['compaction_cache_cost.py', '--prices', () => missing],
  ['compaction_cache_cost.py', '--prices', () => notJson],
  ['compaction_cache_cost.py', '--prices', () => emptyObject],
  ['compaction_cache_cost.py', '--transcript', () => missing],
  ['compaction_cache_cost.py', '--compact', () => missing],
  ['compaction_ask_probe.py', '--compact', () => missing],
  ['compaction_window_drops.py', '--compact', () => missing],
  ['compaction_window_drops.py', '--transcript', () => missing],
  ['empty_results.py', '--transcripts', () => missing],
  ['tool_call_repeats.py', '--transcripts', () => missing],
  ['decision_outcome_join.py', '--journal', () => missing],
  ['decision_outcome_join.py', '--transcripts', () => missing],
  ['executor_outcome_metrics.py', '--transcript', () => missing],
  ['jev_outcome_labels.mjs', '--journal', () => missing],
  ['jev_outcome_labels.mjs', '--transcripts', () => missing],
  ['hook_latency_p95.mjs', '--dir', () => missing],
  ['hook_latency_p95.mjs', '--dir', () => existing],
  ['denial_log_summary.mjs', '--dir', () => missing],
  ['wilson_threshold.mjs', '--input', () => emptyFile],
  ['worktree_report.mjs', '--repos-file', () => missing],
  ['worktree_report.mjs', '--repos-file', () => directory],
];

function run(script: string, args: Args) {
  const file = join(script === 'worktree_report.mjs' ? join(ROOT, 'maintenance') : TOOLS, script);
  const command = script.endsWith('.mjs') ? ['node', [file, ...args]] as const : ['python3', ['-I', '-B', file, ...args]] as const;
  return spawnSync(command[0], [...command[1]], { encoding: 'utf8', timeout: 120000, cwd: base });
}

describe('a refusal with exit code 2 names the path it is about', () => {
  it('the valid runs are valid', () => {
    for (const [script, args] of Object.entries(BASE)) {
      if (script.endsWith('.py') && !hasPython3) continue;
      // The hook and denial tools read a log directory: an empty one is a valid run, except that the denial tool wants a file.
      if (script === 'denial_log_summary.mjs' || script === 'wilson_threshold.mjs') continue;
      const r = run(script, args());
      expect(r.status, `${script}: ${r.stderr}`).toBe(0);
    }
  });

  for (const [script, option, path] of CASES) {
    it.skipIf(script.endsWith('.py') && !hasPython3)(`${script} ${option}: exit 2 and the message names the path`, () => {
      const target = path();
      const before = target === existing ? readFileSync(existing, 'utf8') : '';
      // The denial and the hook log tools take the directory in `--dir` from the base; the others take the option as it is.
      const r = run(script, withOption(BASE[script](), option, target));
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr, 'the message names the path').toContain(target);
      expect(r.stderr).not.toMatch(/Traceback|\n\s+at /);
      if (target === existing) expect(readFileSync(existing, 'utf8'), 'an existing output file is never touched').toBe(before);
    });
  }
});
