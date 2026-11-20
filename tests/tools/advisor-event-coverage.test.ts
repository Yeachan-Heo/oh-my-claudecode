import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wilsonLower } from '../../tools/diagnostics/wilson_threshold.mjs';

// Tests for tools/diagnostics/advisor_event_coverage.py on synthetic transcripts (temp directory only, no network).
// The script needs python3; the suite is skipped when python3 is not installed.
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'diagnostics', 'advisor_event_coverage.py');
const hasPython3 = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;
if (!hasPython3) console.warn('advisor_event_coverage.py tests are skipped: python3 is not available');

const MARKER = 'MARKER-7c1e4a';
const LABEL = 'TEST-LABEL';
const NOT_ENOUGH = 'too little data';
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'advisor-event-coverage-')));
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Row = Record<string, unknown>;
type Block = Record<string, unknown>;

let counter = 0;
const nextId = () => (counter += 1);

function stamp(minute: number, day = 15): string {
  return `2026-11-${String(day).padStart(2, '0')}T10:${String(minute).padStart(2, '0')}:00.000Z`;
}

function assistant(minute: number, blocks: Block[], model: string | null = 'claude-opus-5-5', day = 15): Row {
  const message: Row = { id: `msg-${nextId()}`, role: 'assistant', content: blocks };
  if (model !== null) message.model = model;
  return { type: 'assistant', uuid: `u-${nextId()}`, timestamp: stamp(minute, day), message };
}

/** outcomes: list of [tool_use_id, is_error] pairs. */
function resultsRow(minute: number, outcomes: Array<[string, boolean]>, day = 15): Row {
  const content = outcomes.map(([id, isError]) => ({ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'out' }));
  return { type: 'user', uuid: `u-${nextId()}`, timestamp: stamp(minute, day), message: { role: 'user', content } };
}

const call = (id: string, name: string, input: Row = {}): Block => ({ type: 'tool_use', id, name, input });
const bash = (id: string, command: string): Block => call(id, 'Bash', { command });
const advisor = (id: string): Block => ({ type: 'server_tool_use', id, name: 'advisor', input: {} });
const text = (value: string): Block => ({ type: 'text', text: value });

function writeJsonl(path: string, rows: Row[], rawLines: string[] = []): void {
  mkdirSync(dirname(path), { recursive: true });
  const lines = [...rows.map((row) => JSON.stringify(row)), ...rawLines];
  writeFileSync(path, lines.map((line) => `${line}\n`).join(''), 'utf8');
}

/** sessions: path under the projects directory -> rows; raw: path -> extra raw lines. */
function makeTree(name: string, sessions: Record<string, Row[]>, raw: Record<string, string[]> = {}): string {
  const root = join(WORK, name);
  for (const [relative, rows] of Object.entries(sessions)) writeJsonl(join(root, relative), rows, raw[relative] ?? []);
  return root;
}

interface Run { code: number | null; out: string; err: string }

function runTool(root: string, extra: string[] = [], label: string | null = LABEL, cwd?: string): Run {
  const argv = ['-I', SCRIPT, '--projects', root];
  if (label !== null) argv.push('--label', label);
  const done = spawnSync('python3', [...argv, ...extra], { encoding: 'utf8', cwd });
  return { code: done.status, out: done.stdout, err: done.stderr };
}

function runReport(root: string, extra: string[] = []): Json {
  const done = runTool(root, extra);
  expect(done.code, `exit ${done.code}: ${done.err}`).toBe(0);
  return JSON.parse(done.out);
}

/** In-process python helper: runs a snippet with the tool loaded as a module; the snippet prints one JSON value. */
function inProcess(snippet: string, ...args: string[]): Json {
  const prelude = [
    'import importlib.util, io, contextlib, json, os, sys',
    'sys.dont_write_bytecode = True',
    'spec = importlib.util.spec_from_file_location("advisor_event_coverage", sys.argv[1])',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
  ].join('\n');
  const done = spawnSync('python3', ['-I', '-c', `${prelude}\n${snippet}`, SCRIPT, ...args], { encoding: 'utf8' });
  expect(done.status, done.stderr).toBe(0);
  return JSON.parse(done.stdout);
}

const group = (report: Json, cls: string, session = 'claude'): Json => report.events[cls][session];
const cell = (grp: Json, key: string): Json => grp.coverage[key];

/** One session whose plan event sits `distance` calls after its only advisor consultation.
 * Call ids carry `tag`, so every file has its own ids (copies of ids would be counted once). */
function planSession(distance: number, tag = ''): Row[] {
  const rows = [assistant(1, [advisor(`c1${tag}`)])];
  if (distance > 1) {
    rows.push(assistant(2, Array.from({ length: distance - 1 }, (_, k) => bash(`f${k}${tag}`, 'ls'))));
  }
  rows.push(assistant(5, [call(`p1${tag}`, 'ExitPlanMode')]));
  return rows;
}

function planSessions(count: number): Record<string, Row[]> {
  const sessions: Record<string, Row[]> = {};
  for (let i = 0; i < count; i += 1) sessions[`proj/s${String(i).padStart(2, '0')}.jsonl`] = planSession((i % 5) + 1, `-${String(i).padStart(2, '0')}`);
  return sessions;
}

const SESSION_FIELDS = ['session', 'model_class', 'transcript', 'fired', 'advisor_rows'];
const SINCE = '2026-11-15T00:00:00Z';
// SHA-256 of the report text for sessionsFixture with --since SINCE. It pins the report format (keys, order, number
// formatting); regenerate it only when the report changes on purpose.
const GOLDEN_REPORT_SHA256 = '7d35eb59751cb5bee186fb2ef18a19ef7bea9be935c9200992f02e8140c409b1';

function runSessions(root: string, name: string, extra: string[] = [], cwd?: string): { stdout: string; listed: Json[]; target: string; mode: number } {
  const target = join(WORK, `sessions-${name}.json`);
  const done = runTool(root, ['--sessions-out', target, ...extra], LABEL, cwd);
  expect(done.code, `exit ${done.code}: ${done.err}`).toBe(0);
  return { stdout: done.out, listed: JSON.parse(readFileSync(target, 'utf8')), target, mode: statSync(target).mode & 0o777 };
}

function sessionsFixture(name: string): string {
  return makeTree(name, {
    'proj-b/s-beta.jsonl': [
      assistant(1, [advisor('b-c1')], 'claude-haiku-5-5'),
      assistant(2, [text('ADVISOR: confirm: ok')], 'claude-haiku-5-5'),
      assistant(3, [advisor('b-c2')], 'claude-haiku-5-5'),
    ],
    'proj-a/s-alpha.jsonl': [
      assistant(1, [advisor('a-c1')]),
      assistant(2, [bash('a-b1', 'ask-advisor --ask')]),
    ],
    'proj-a/s-gamma.jsonl': [
      assistant(1, [bash('g-b1', 'ask-advisor --ask')], 'glm-5.3'),
      assistant(2, [text('ADVISOR: change: a\nADVISOR: reject: b')], 'glm-5.3'),
    ],
    'proj-a/s-delta.jsonl': [assistant(1, [bash('d-b1', 'ls')])],
    'proj-a/s-old.jsonl': [assistant(1, [advisor('o-c1')], 'claude-opus-5-5', 10)],
    // a call and a declaration line before the window, and one of each inside it
    'proj-a/s-mixed.jsonl': [
      assistant(1, [advisor('m-c1')], 'claude-opus-5-5', 10),
      assistant(2, [text('ADVISOR: confirm: before the window')], 'claude-opus-5-5', 10),
      assistant(3, [advisor('m-c2')]),
      assistant(4, [text('ADVISOR: change: inside the window')]),
    ],
    // rows in the window, but the call and the declaration line are before it: not listed
    'proj-a/s-prewin.jsonl': [
      assistant(1, [advisor('w-c1')], 'claude-opus-5-5', 10),
      assistant(2, [text('ADVISOR: reject: before the window')], 'claude-opus-5-5', 10),
      assistant(3, [bash('w-b1', 'ls')]),
    ],
    'proj-a/s-alpha/subagents/agent-1.jsonl': [assistant(1, [advisor('x-c1')])],
  });
}

describe.skipIf(!hasPython3)('advisor_event_coverage.py', () => {
  it('plan at distance 2 from the consultation: covered for K=2, not for K=1; counts kept below n 30', () => {
    const root = makeTree('plan-distance', { 'proj/s1.jsonl': [
      assistant(1, [advisor('c1')]),
      assistant(2, [bash('b1', 'ls')]),
      assistant(3, [call('p1', 'ExitPlanMode')]),
    ] });
    const report = runReport(root);
    const grp = group(report, 'plan');
    expect(grp.n).toBe(1);
    expect(grp.distance_distribution.min).toBe(2);
    expect(grp.distance_distribution.max).toBe(2);
    expect(cell(grp, 'K=1').covered).toBe(0);
    expect(cell(grp, 'K=2').covered).toBe(1);
    expect(cell(grp, 'K=unlimited').covered).toBe(1);
    expect(cell(grp, 'K=1').share).toBe(NOT_ENOUGH);
    expect(cell(grp, 'K=1').wilson_lower_bound).toBe(NOT_ENOUGH);
    expect(report.consultations.advisor.claude).toBe(1);
    expect(report.sessions.claude).toBe(1);
    expect(report.sessions.total).toBe(1);
    expect(report.template).toBe('advisor-event-coverage/1');
    expect(report.label).toBe(LABEL);
  });

  it('a report-prefix block that is also the last text is one end event; uncovered', () => {
    const root = makeTree('end-uncovered', { 'proj/s1.jsonl': [
      assistant(1, [bash('b1', 'make')]),
      assistant(2, [text('STATUS: done')]),
    ] });
    const grp = group(runReport(root), 'end');
    expect(grp.n).toBe(1);
    expect(cell(grp, 'K=unlimited').covered).toBe(0);
    expect(grp.distance_distribution).toBeNull();
  });

  it('a series of 3 errors gives one failures event at the 2nd error; distances 1 and 2', () => {
    const root = makeTree('failures', {
      'proj/a.jsonl': [
        assistant(1, [bash('b1', 'x')]), resultsRow(1, [['b1', true]]),
        assistant(2, [bash('b2', 'x')]), resultsRow(2, [['b2', true]]),
        assistant(3, [advisor('c1')]),
        assistant(4, [bash('b3', 'x')]), resultsRow(4, [['b3', true]]),
      ],
      'proj/b.jsonl': [
        assistant(1, [bash('bb1', 'x')]), resultsRow(1, [['bb1', true]]),
        assistant(2, [bash('bb2', 'x')]), resultsRow(2, [['bb2', true]]),
        assistant(3, [bash('bb3', 'x')]), resultsRow(3, [['bb3', true]]),
        assistant(4, [advisor('cb1')]),
      ],
    });
    const grp = group(runReport(root), 'failures');
    expect(grp.n).toBe(2);
    expect(grp.distance_distribution.min).toBe(1);
    expect(grp.distance_distribution.max).toBe(2);
    expect(cell(grp, 'K=1').covered).toBe(1);
    expect(cell(grp, 'K=2').covered).toBe(2);
  });

  it('error, ok, error: no failures event', () => {
    const root = makeTree('broken-series', { 'proj/s1.jsonl': [
      assistant(1, [bash('b1', 'x')]), resultsRow(1, [['b1', true]]),
      assistant(2, [bash('b2', 'x')]), resultsRow(2, [['b2', false]]),
      assistant(3, [bash('b3', 'x')]), resultsRow(3, [['b3', true]]),
    ] });
    const grp = group(runReport(root), 'failures');
    expect(grp.n).toBe(0);
    expect(grp.distance_distribution).toBeNull();
  });

  it('3 declaration lines (leading whitespace allowed, mid-line not); no consultation created', () => {
    const root = makeTree('declarations', { 'proj/s1.jsonl': [
      assistant(1, [text('ADVISOR: change: a')]),
      assistant(2, [text('intro\n  ADVISOR: confirm: b\nADVISOR: reject: c')]),
      assistant(3, [text('text ADVISOR: in the middle of a line')]),
    ] });
    const report = runReport(root);
    expect(report.declaration_lines.claude).toBe(3);
    expect(report.consultations.advisor.claude).toBe(0);
  });

  it('prefixes are configurable: --declaration-prefix and --report-prefix replace the defaults', () => {
    const root = makeTree('prefixes', { 'proj/s1.jsonl': [
      assistant(1, [advisor('c1')]),
      assistant(2, [text('NOTE: first\nADVISOR: default prefix no longer counts')]),
      assistant(3, [text('DONE: final')]),
      assistant(4, [text('plain closing text')]),
    ] });
    const options = ['--declaration-prefix', 'NOTE:', '--report-prefix', 'DONE:'];
    const report = runReport(root, options);
    expect(report.declaration_lines.claude).toBe(1);
    expect(group(report, 'end').n).toBe(2);
    const defaults = runReport(root);
    expect(defaults.declaration_lines.claude).toBe(1);
    expect(group(defaults, 'end').n).toBe(1);
    for (const bad of [['--declaration-prefix', ''], ['--report-prefix', '']]) {
      const done = runTool(root, bad);
      expect(done.code).toBe(2);
      expect(done.out).toBe('');
    }
  });

  it('duplicate ids do not move positions: plan still at distance 2', () => {
    const root = makeTree('dedupe', { 'proj/s1.jsonl': [
      assistant(1, [advisor('c1')]),
      assistant(2, [bash('b1', 'ls')]),
      assistant(2, [bash('b1', 'ls')]),
      assistant(2, [advisor('c1')]),
      assistant(3, [call('p1', 'ExitPlanMode')]),
    ] });
    const report = runReport(root);
    expect(report.consultations.advisor.claude).toBe(1);
    expect(group(report, 'plan').distance_distribution.min).toBe(2);
  });

  it('synthetic rows add no calls, no events and no text events', () => {
    const root = makeTree('synthetic', { 'proj/s1.jsonl': [
      assistant(1, [advisor('c1')]),
      assistant(2, [call('s1', 'ExitPlanMode'), text('STATUS: skipped')], '<synthetic>'),
      assistant(3, [call('p1', 'ExitPlanMode')]),
    ] });
    const report = runReport(root);
    const grp = group(report, 'plan');
    expect(grp.n).toBe(1);
    expect(grp.distance_distribution.min).toBe(1);
    expect(group(report, 'end').n).toBe(0);
  });

  it('5 plan events: /plans/ path, BRIEF and PLAN names, name prefix plan, first TodoWrite only', () => {
    const root = makeTree('plan-rules', { 'proj/s1.jsonl': [
      assistant(1, [call('w1', 'Write', { file_path: 'x/plans/a.md' })]),
      assistant(2, [call('e1', 'Edit', { file_path: 'docs/BRIEF-x.md' })]),
      assistant(3, [call('w2', 'Write', { file_path: 'notes/PLAN-2.md' })]),
      assistant(4, [call('w3', 'Write', { file_path: 'docs/readme.md' })]),
      assistant(5, [call('e2', 'Edit', { file_path: 'src/planner.ts' })]),
      assistant(6, [call('t1', 'TodoWrite', { todos: [] })]),
      assistant(7, [call('t2', 'TodoWrite', { todos: [] })]),
    ] });
    expect(group(runReport(root), 'plan').n).toBe(5);
  });

  it('classes glm/haiku/claude, model-less and tied sessions go to claude; kinds and distances as designed', () => {
    const root = makeTree('classes', {
      'proj/glm.jsonl': [
        assistant(1, [bash('g-b1', 'KEY=x ask-advisor --ask')], 'glm-5.3'),
        assistant(2, [call('g-p1', 'ExitPlanMode')], 'glm-5.3'),
      ],
      'proj/haiku.jsonl': [
        assistant(1, [bash('h-b1', 'X=1 ask-backup run')], 'claude-haiku-5-5'),
        assistant(2, [bash('h-b2', 'echo ask-advisor')], 'claude-haiku-5-5'),
        assistant(3, [bash('h-b3', 'grep ask-backup notes')], 'claude-haiku-5-5'),
        assistant(4, [call('h-p1', 'ExitPlanMode')], 'claude-haiku-5-5'),
      ],
      'proj/claude.jsonl': [
        assistant(1, [advisor('c-c1')]),
        assistant(2, [bash('c-b1', 'ls')]),
        assistant(3, [call('c-p1', 'ExitPlanMode')]),
      ],
      'proj/nomodel.jsonl': [
        assistant(1, [call('n-p1', 'ExitPlanMode')], null),
      ],
      'proj/tie.jsonl': [
        assistant(1, [text('hello')], 'glm-5.3'),
        assistant(2, [text('hello')], 'claude-opus-5-5'),
      ],
    });
    const report = runReport(root, ['--consult-command', 'ask-advisor', '--consult-command', 'ask-backup']);
    expect(report.sessions).toEqual({ glm: 1, haiku: 1, claude: 3, total: 5 });
    expect(report.consultations['bash-ask-advisor']).toEqual({ glm: 1, haiku: 0, claude: 0, total: 1 });
    expect(report.consultations['bash-ask-backup'].haiku).toBe(1);
    expect(report.consultations['bash-ask-backup'].total).toBe(1);
    expect(group(report, 'plan', 'glm').distance_distribution.min).toBe(1);
    expect(group(report, 'plan', 'haiku').distance_distribution.min).toBe(3);
    const claudePlan = group(report, 'plan', 'claude');
    expect(claudePlan.n).toBe(2);
    expect(claudePlan.distance_distribution.min).toBe(2);
    expect(cell(claudePlan, 'K=2').covered).toBe(1);
    expect(group(report, 'plan', 'total').n).toBe(4);
  });

  it('a consultation is the first word after leading assignments and redirections, whatever the value or the target holds', () => {
    const values = [
      'MODE="deep analysis"', "MODE='deep analysis'", 'MODE=deep\\ analysis', 'MODE=', 'A=$(date)', 'A=$(a b c)', 'A=`date`', 'A="$(a b)"',
      'A=$(echo ")")', 'A=$(a $(b c))', 'A="x y"z', 'A=x"y z"', 'A+=y', 'A=b\\ c\\ d', 'B=1 MODE="a b"', '> out.log', '2>&1', '&> all.log', '< in.txt',
      '>| out', '>>out', '2> err', '{fd}> out', '> "my out.log"', '> out.log MODE="a b"', 'MODE="a b" 2>&1', '>f\\ x',
    ];
    const hits = values.map((value) => `${value} ask-advisor --ask`);
    const misses = [
      'echo $(date) ask-advisor', 'echo `date` ask-advisor', 'echo hi > ask-advisor', 'echo hi 2>&1 ask-advisor', 'cat < ask-advisor', 'echo $(ask-advisor)',
      'MODE="a b" echo ask-advisor', 'MODE="a b" ask-advisor-extra', '> ask-advisor', 'MODE="a b"', '2>&1', 'MODE="a b" > ',
    ];
    const calls = [...hits, ...misses].map((command, index) => assistant(index + 1, [bash(`b${index}`, command)]));
    const report = runReport(makeTree('prefix-forms', { 'proj/s1.jsonl': calls }), ['--consult-command', 'ask-advisor']);
    expect(report.consultations['bash-ask-advisor'].total).toBe(hits.length);
    // An empty substitution expands to nothing, so the next word is the first word.
    const empty = runReport(
      makeTree('empty-substitution', { 'proj/s1.jsonl': [assistant(1, [bash('e1', '$() ask-advisor')]), assistant(2, [bash('e2', '`` ask-advisor')])] }),
      ['--consult-command', 'ask-advisor'],
    );
    expect(empty.consultations['bash-ask-advisor'].total).toBe(2);
    // A long run of prefixes is read in one pass.
    const long = runReport(
      makeTree('long-prefix', { 'proj/s1.jsonl': [assistant(1, [bash('l1', 'A="b c" '.repeat(20000) + 'ask-advisor')]), assistant(2, [bash('l2', '> o '.repeat(20000) + 'ask-advisor')])] }),
      ['--consult-command', 'ask-advisor'],
    );
    expect(long.consultations['bash-ask-advisor'].total).toBe(2);
  });

  it('launch wrappers are taken off with the options of the table, and the command behind them is the consultation', () => {
    const hits = [
      'sudo ', 'sudo -E ', 'sudo --preserve-env ', 'sudo --preserve-env=PATH ', 'sudo -u root ', 'sudo --user root ', 'sudo --user=root ', 'sudo -uroot ', 'nohup ',
      'command ', 'command -p ', 'exec ', 'exec -a name ', 'nice ', 'nice -n 5 ', 'nice -n5 ', 'nice --adjustment 5 ', 'nice --adjustment=5 ', 'time ', 'time -p ',
      'timeout 5 ', 'timeout 1.5m ', 'timeout .5 ', 'timeout -s KILL 5 ', 'timeout --signal=KILL 5 ', 'timeout -k 2 5 ', 'timeout -s KILL -k 2s 5 ', 'timeout --kill-after 2 5 ',
      'env ', 'env -i ', 'env --ignore-environment ', 'env -u NAME ', 'env --unset NAME ', 'env --unset=NAME ', 'env A=1 ', 'sudo env A=1 nohup ', 'sudo A=1 ',
      'nice -n 5 timeout 5 sudo -u root env -i A=1 ', '/usr/bin/env ', '/usr/bin/sudo ', 'sudo > out.log ', 'A="b c" sudo ', '> out.log sudo ',
      // Options of the table that do not change which command runs, `--`, glued flags, a number as an option, a long option abbreviated.
      'sudo -n ', 'sudo -H ', 'sudo -S ', 'sudo -k ', 'sudo -i ', 'sudo -g adm ', 'sudo -nu root ', 'sudo -Eu root ', 'sudo -- ', 'sudo --set-home ', 'sudo --chdir=/tmp ',
      'timeout --foreground 5 ', 'timeout -v 5 ', 'timeout -fv -s 9 5 ', 'timeout --sig=KILL 5 ', 'timeout -- 5 ', 'timeout 1e1 ', 'timeout inf ', 'timeout 0x5 ',
      'nice -5 ', 'nice --5 ', 'nice -n -5 ', 'nice --adj=3 ', 'nice -- ', 'env - ', 'env -C /tmp ', 'env --chdir=/tmp ', 'env -a x ', 'env -S ', 'env -v ', 'env -- ',
      'command -- ', 'exec -c ', 'exec -cl ', 'nohup -- ', 'time -- ', 'time -f %e ', '/usr/bin/time -v ',
    ].map((prefix) => `${prefix}ask-advisor --ask`);
    const misses = [
      // No command runs behind the wrapper: a bare wrapper, an option that only lists or describes (`stop`), a bad duration, an
      // assignment behind a wrapper that takes none, and an option that is not in the table (nothing is guessed).
      'sudo -l ask-advisor', 'sudo -v ask-advisor', 'sudo -e ask-advisor', 'sudo -K ask-advisor', 'sudo --help ask-advisor', 'sudo -u', 'sudo -u root', 'sudo', 'nohup',
      'nohup --version ask-advisor', 'command -v ask-advisor', 'command -V ask-advisor', 'exec -a', 'nice -n', 'timeout ask-advisor', 'timeout 5', 'timeout',
      'timeout abc ask-advisor', 'timeout 5x ask-advisor', 'timeout 5S ask-advisor', 'timeout -s', 'timeout 5 -- ask-advisor', 'env -0 ask-advisor', 'env -u',
      'nohup -x ask-advisor', 'sudo -z ask-advisor', 'sudo --no-such-option ask-advisor', 'timeout --no-such 5 ask-advisor', 'sudo -E -z ask-advisor',
      'nohup A=1 ask-advisor', 'timeout 5 A=1 ask-advisor', 'nice A=1 ask-advisor', 'command A=1 ask-advisor', 'exec A=1 ask-advisor',
      'sudo echo ask-advisor', 'sudo ask-advisor-extra',
      // Only the first command of the text counts: the wrapper is no boundary, and a newline ends the command.
      'sudo -n true; ask-advisor', 'echo hi && sudo ask-advisor', 'timeout 5\nask-advisor --ask', 'sudo\nask-advisor --ask',
    ];
    const calls = [...hits, ...misses].map((command, index) => assistant(index + 1, [bash(`w${index}`, command)]));
    const report = runReport(makeTree('wrappers', { 'proj/s1.jsonl': calls }), ['--consult-command', 'ask-advisor']);
    expect(report.consultations['bash-ask-advisor'].total).toBe(hits.length);
    // A long run of wrappers and options is read in linear time, and a chain longer than eight reads nothing.
    const started = Date.now();
    const long = runReport(
      makeTree('long-wrappers', { 'proj/s1.jsonl': [
        assistant(1, [bash('l1', 'sudo -E '.repeat(5000) + 'ask-advisor')]),
        assistant(2, [bash('l2', 'sudo -E ' + '-n '.repeat(13000) + 'ask-advisor')]),
        assistant(3, [bash('l3', 'sudo '.repeat(7) + 'ask-advisor')]),
        assistant(4, [bash('l4', 'sudo '.repeat(9) + 'ask-advisor')]),
      ] }),
      ['--consult-command', 'ask-advisor'],
    );
    expect(long.consultations['bash-ask-advisor'].total).toBe(2); // many options of one wrapper, and seven wrappers
    expect(Date.now() - started).toBeLessThan(20000);
  });

  it("the first plan has no consultation; the second plan's range starts after the first event", () => {
    const root = makeTree('two-plans', { 'proj/s1.jsonl': [
      assistant(1, [call('p1', 'ExitPlanMode')]),
      assistant(2, [advisor('c1')]),
      assistant(3, [call('p2', 'ExitPlanMode')]),
    ] });
    const grp = group(runReport(root), 'plan');
    expect(grp.n).toBe(2);
    expect(grp.distance_distribution).toEqual({ min: 1, median: 1, p75: 1, p90: 1, max: 1 });
    expect(cell(grp, 'K=1').covered).toBe(1);
  });

  it('a report-prefix event is covered at distance 1; the last text is uncovered (range starts after the previous end event)', () => {
    const root = makeTree('end-bounds', { 'proj/s1.jsonl': [
      assistant(1, [advisor('c1')]),
      assistant(2, [bash('b2', 'ls')]),
      assistant(2, [text('STATUS: first')]),
      assistant(3, [bash('b3', 'ls')]),
      assistant(3, [text('plain text')]),
    ] });
    const grp = group(runReport(root), 'end');
    expect(grp.n).toBe(2);
    expect(grp.distance_distribution).toEqual({ min: 1, median: 1, p75: 1, p90: 1, max: 1 });
    expect(cell(grp, 'K=1').covered).toBe(1);
    expect(cell(grp, 'K=unlimited').covered).toBe(1);
  });

  it('end events at one call position keep their order: a consultation covers only the first of them', () => {
    // The report-prefix block and the last text block, with no call between them: both sit after call 2.
    const cases: Record<string, Row[]> = {
      'same-message': [assistant(1, [advisor('c1')]), assistant(2, [bash('b2', 'ls')]),
        assistant(3, [text('STATUS: done'), text('closing words')])],
      'two-messages': [assistant(1, [advisor('c1')]), assistant(2, [bash('b2', 'ls')]),
        assistant(3, [text('STATUS: done')]), assistant(4, [text('closing words')])],
    };
    for (const [name, rows] of Object.entries(cases)) {
      const grp = group(runReport(makeTree(`end-same-position-${name}`, { 'proj/s1.jsonl': rows })), 'end');
      expect(grp.n, name).toBe(2);
      expect(cell(grp, 'K=unlimited').covered, name).toBe(1);
      expect(cell(grp, 'K=1').covered, name).toBe(1);
      expect(grp.distance_distribution, name).toEqual({ min: 1, median: 1, p75: 1, p90: 1, max: 1 });
    }
    // Three events at one position: only the first can be covered; a later position starts a new range.
    const three = [assistant(1, [bash('b1', 'ls')]), assistant(2, [text('STATUS: early')]),
      assistant(3, [advisor('c2')]), assistant(4, [bash('b3', 'ls')]),
      assistant(5, [text('STATUS: a'), text('STATUS: b'), text('last')])];
    const grp3 = group(runReport(makeTree('end-same-position-three', { 'proj/s1.jsonl': three })), 'end');
    expect(grp3.n).toBe(4);
    expect(cell(grp3, 'K=unlimited').covered).toBe(1);
    expect(grp3.distance_distribution).toEqual({ min: 1, median: 1, p75: 1, p90: 1, max: 1 });
    // The same rule in both directions, on events built by hand: a forward range ends at the next event, also at one position.
    const snippet = [
      'scan = module.SessionScan()',
      'scan.consults = [(4, "advisor", True, None, True)]',
      'scan.events = [(module.FAILURES, 3, True, None, True), (module.FAILURES, 3, True, None, True),',
      '               (module.PLAN, 5, True, None, True), (module.PLAN, 5, True, None, True)]',
      'print(json.dumps([item[3] for item in module.event_distances(scan)]))',
    ].join('\n');
    expect(inProcess(snippet)).toEqual([null, 1, 1, null]);
  });

  it('n 30: numbers, nearest-rank distribution, lower Wilson bound equal to the shared Wilson helper within 1e-9', () => {
    const grp = group(runReport(makeTree('n30', planSessions(30))), 'plan');
    expect(grp.n).toBe(30);
    const expected: Record<string, number> = { 'K=1': 6, 'K=2': 12, 'K=3': 18, 'K=5': 30, 'K=10': 30, 'K=20': 30, 'K=unlimited': 30 };
    let previous = -1;
    for (const key of ['K=1', 'K=2', 'K=3', 'K=5', 'K=10', 'K=20', 'K=unlimited']) {
      expect(cell(grp, key).covered, key).toBe(expected[key]);
      expect(cell(grp, key).covered, 'coverage must not fall as K grows').toBeGreaterThanOrEqual(previous);
      previous = cell(grp, key).covered;
    }
    expect(grp.distance_distribution).toEqual({ min: 1, median: 3, p75: 4, p90: 5, max: 5 });
    expect(cell(grp, 'K=1').share).toBe(6 / 30);
    const byKey: Record<number, string> = { 6: 'K=1', 12: 'K=2', 18: 'K=3', 30: 'K=5' };
    for (const k of [6, 12, 18, 30]) {
      const got = cell(grp, byKey[k]).wilson_lower_bound;
      expect(typeof got).toBe('number');
      expect(Math.abs(got - (wilsonLower(k, 30, 1.645) as number))).toBeLessThan(1e-9);
    }
  });

  it('n 29 (below minimum support 30): counts kept, share and bound read the text', () => {
    const grp = group(runReport(makeTree('n29', planSessions(29))), 'plan');
    expect(grp.n).toBe(29);
    expect(cell(grp, 'K=1').covered).toBe(6);
    expect(cell(grp, 'K=5').covered).toBe(29);
    for (const key of ['K=1', 'K=5', 'K=unlimited']) {
      expect(cell(grp, key).share, key).toBe(NOT_ENOUGH);
      expect(cell(grp, key).wilson_lower_bound, key).toBe(NOT_ENOUGH);
    }
  });

  it('subagent files are counted only: no extra event, their broken line is not read', () => {
    const sessions = planSessions(30);
    sessions['proj/s00/subagents/agent-1.jsonl'] = [assistant(5, [call('p9', 'ExitPlanMode')])];
    const report = runReport(makeTree('n30-sub', sessions, { 'proj/s00/subagents/agent-1.jsonl': ['{broken'] }));
    expect(report.files).toEqual({ main: 30, subagents: 1 });
    expect(group(report, 'plan').n).toBe(30);
    expect(report.data_quality.bad_lines).toBe(0);
  });

  it('window: an out-of-window session is dropped; a consultation outside the window still covers the plan', () => {
    const root = makeTree('window', {
      'proj/in.jsonl': [
        assistant(1, [advisor('c1')]),
        assistant(2, [bash('b1', 'ls')]),
        assistant(5, [call('p1', 'ExitPlanMode')]),
      ],
      'proj/out.jsonl': [
        assistant(1, [advisor('c2')], 'claude-opus-5-5', 14),
        assistant(2, [call('p2', 'ExitPlanMode')], 'claude-opus-5-5', 14),
      ],
    });
    const report = runReport(root, ['--since', '2026-11-15T10:03:00Z', '--until', '2026-11-15T10:20:00Z']);
    expect(report.sessions.claude).toBe(1);
    expect(report.consultations.advisor.claude).toBe(0);
    const grp = group(report, 'plan');
    expect(grp.n).toBe(1);
    expect(grp.distance_distribution.min).toBe(2);
    expect(report.period.rows_in_window).toEqual({ from: '2026-11-15T10:05:00Z', to: '2026-11-15T10:05:00Z' });
  });

  it('data quality: valid rows 3, one bad line, one row without time, no session without time', () => {
    const root = makeTree('quality', { 'proj/s1.jsonl': [
      assistant(1, [advisor('c1')]),
      { type: 'summary', summary: 'no time here' },
      assistant(2, [call('p1', 'ExitPlanMode')]),
    ] }, { 'proj/s1.jsonl': ['{not json'] });
    expect(runReport(root).data_quality).toEqual({ rows: 3, bad_lines: 1, rows_without_time: 1, sessions_without_time: 0 });
  });

  it('a marker in text, command, file path, directory and file name, and a bad line is absent from the output', () => {
    const rel = `proj-${MARKER}/s-${MARKER}.jsonl`;
    const root = makeTree(`marker-${MARKER}`, {
      [rel]: [
        assistant(1, [text(`STATUS: ${MARKER}`)]),
        assistant(2, [bash('b1', `echo ${MARKER}`)]),
        assistant(3, [call('w1', 'Write', { file_path: `${MARKER}/plans/${MARKER}.md` })]),
      ],
    }, { [rel]: [`{${MARKER} broken`] });
    const outPath = join(WORK, `out-${MARKER}.json`);
    const done = runTool(root, ['--out', outPath]);
    expect(done.code, done.err).toBe(0);
    expect(done.out).not.toContain(MARKER);
    expect(done.err).not.toContain(MARKER);
    const written = readFileSync(outPath, 'utf8');
    expect(written).not.toContain(MARKER);
    const report = JSON.parse(written);
    expect(report.data_quality.bad_lines).toBe(1);
    expect(report.events.plan.claude.n).toBe(1);
  });

  it('usage and input errors exit 2; an existing --out file is untouched; a new --out file has mode 0600', () => {
    const root = makeTree('exit-codes', { 'proj/s1.jsonl': [assistant(1, [call('p1', 'ExitPlanMode')])] });
    const cases: Record<string, string[]> = {
      'missing --label': ['-I', SCRIPT, '--projects', root],
      'missing --projects': ['-I', SCRIPT, '--label', LABEL],
      'projects is not a directory': ['-I', SCRIPT, '--projects', join(WORK, 'nope'), '--label', LABEL],
      'bad --since': ['-I', SCRIPT, '--projects', root, '--label', LABEL, '--since', 'not-a-date'],
      'since not before until': ['-I', SCRIPT, '--projects', root, '--label', LABEL, '--since', '2026-11-16T12:00:00Z', '--until', '2026-11-15T00:00:00Z'],
      'consult command with two words': ['-I', SCRIPT, '--projects', root, '--label', LABEL, '--consult-command', 'two words'],
    };
    for (const [label, argv] of Object.entries(cases)) {
      expect(spawnSync('python3', argv, { encoding: 'utf8' }).status, label).toBe(2);
    }
    const existing = join(WORK, 'existing.json');
    writeFileSync(existing, 'keep', 'utf8');
    expect(runTool(root, ['--out', existing]).code).toBe(2);
    expect(readFileSync(existing, 'utf8')).toBe('keep');
    const fresh = join(WORK, 'fresh.json');
    const done = runTool(root, ['--out', fresh]);
    expect(done.code, done.err).toBe(0);
    expect(statSync(fresh).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(fresh, 'utf8')).template).toBe('advisor-event-coverage/1');
  });

  it('a --projects directory that cannot be read exits 2 instead of giving an empty report', () => {
    const root = makeTree('unreadable-projects', { 'proj/s1.jsonl': [assistant(1, [call('p1', 'ExitPlanMode')])] });
    // The test may run as a user that can read every directory, so the permission test is answered by the snippet.
    const [granted, code, message] = inProcess([
      'err = io.StringIO()',
      'real_access = os.access',
      'os.access = lambda path, mode: False if path == sys.argv[2] else real_access(path, mode)',
      'with contextlib.redirect_stderr(err):',
      '    code = module.main(["--projects", sys.argv[2], "--label", sys.argv[3]])',
      'os.access = real_access',
      'with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):',
      '    granted = module.main(["--projects", sys.argv[2], "--label", sys.argv[3]])',
      'print(json.dumps([granted, code, err.getvalue()]))',
    ].join('\n'), root, LABEL);
    expect(code).toBe(2);
    expect(message).toContain('--projects cannot be read');
    expect(granted).toBe(0);
  });

  it('wilson_lower equals the shared Wilson helper (k, n, 1.645) for 10 pairs, difference below 1e-9', () => {
    const pairs = [[0, 30], [1, 30], [6, 30], [12, 30], [18, 30], [30, 30], [0, 100], [37, 100], [250, 300], [1, 31]];
    const values: number[] = inProcess('print(json.dumps([module.wilson_lower(k, n) for k, n in json.loads(sys.argv[2])]))', JSON.stringify(pairs));
    expect(values).toHaveLength(pairs.length);
    pairs.forEach(([k, n], index) => {
      expect(Math.abs(values[index] - (wilsonLower(k, n, 1.645) as number)), `${k}/${n}`).toBeLessThan(1e-9);
    });
  });

  it('the same history in two files: plan and end n 1, advisor counted once, duplicates by kind', () => {
    const history = [assistant(1, [advisor('k1')]), assistant(3, [call('k2', 'ExitPlanMode')]), assistant(4, [text('STATUS: ready')])];
    const report = runReport(makeTree('copies', { 'proj/a.jsonl': history, 'proj/b.jsonl': history }));
    expect(group(report, 'plan').n).toBe(1);
    expect(group(report, 'end').n).toBe(1);
    expect(report.consultations.advisor.total).toBe(1);
    const dup = report.duplicates;
    expect(dup.calls).toBe(2);
    expect(dup.texts).toBe(1);
    expect(dup.consultations.advisor).toBe(1);
    expect(dup.events.plan).toBe(1);
    expect(dup.events.end).toBe(1);
    expect(dup.events.failures).toBe(0);
  });

  it('a consult command matches the first word only; the environment prefix is kept; an env-only command is safe', () => {
    const root = makeTree('consult-words', { 'proj/s1.jsonl': [
      assistant(1, [bash('w1', 'ask-advisor-old --ask')]),
      assistant(2, [bash('w2', 'ask-backup2 run')]),
      assistant(3, [bash('w3', 'FOO=1 ')]),
      assistant(4, [bash('w4', 'KEY=x ask-advisor --ask')]),
    ] });
    const report = runReport(root, ['--consult-command', 'ask-advisor', '--consult-command', 'ask-backup']);
    expect(report.consultations['bash-ask-advisor'].total).toBe(1);
    expect(report.consultations['bash-ask-backup'].total).toBe(0);
    const without = runReport(root);
    expect(Object.keys(without.consultations)).toEqual(['advisor']);
  });

  it('--sessions-out off: the report text is identical with and without the option and equals the pinned format', () => {
    const root = sessionsFixture('sessions-off');
    const options = ['--consult-command', 'ask-advisor', '--since', SINCE];
    const plain = runTool(root, options);
    const withList = runSessions(root, 'off', options);
    expect(plain.code).toBe(0);
    expect(plain.err).toBe('');
    expect(plain.out).not.toBe('');
    expect(plain.out).toBe(withList.stdout);
    expect(createHash('sha256').update(plain.out, 'utf8').digest('hex')).toBe(GOLDEN_REPORT_SHA256);
  });

  it('--sessions-out list holds only sessions with advisor calls or declaration lines in the window; clipped counts; sorted; absolute paths; sums equal the report', () => {
    const root = sessionsFixture('sessions-list');
    // a relative --projects (the directory name only, cwd next to it): the listed paths must still be absolute
    const { stdout, listed, mode } = runSessions('sessions-list', 'list', ['--since', SINCE], WORK);
    expect(mode).toBe(0o600);
    expect(listed.map((item) => item.session)).toEqual(['s-alpha', 's-beta', 's-gamma', 's-mixed']);
    for (const item of listed) {
      expect(Object.keys(item)).toEqual(SESSION_FIELDS);
      expect(isAbsolute(item.transcript) && existsSync(item.transcript), item.transcript).toBe(true);
      expect(item.transcript.endsWith(`${item.session}.jsonl`)).toBe(true);
    }
    expect(root).toBe(join(WORK, 'sessions-list'));
    const byId: Record<string, Json> = Object.fromEntries(listed.map((item) => [item.session, item]));
    const triple = (name: string) => [byId[name].model_class, byId[name].fired, byId[name].advisor_rows];
    expect(triple('s-alpha')).toEqual(['claude', 1, 0]);
    expect(triple('s-beta')).toEqual(['haiku', 2, 1]);
    expect(triple('s-gamma')).toEqual(['glm', 0, 2]);
    // one call and one declaration line before the window are not counted; s-prewin has nothing inside: not listed
    expect(triple('s-mixed')).toEqual(['claude', 1, 1]);
    const report = JSON.parse(stdout);
    const fired = listed.reduce((sum, item) => sum + item.fired, 0);
    const rows = listed.reduce((sum, item) => sum + item.advisor_rows, 0);
    expect(fired).toBe(report.consultations.advisor.total);
    expect(fired).toBe(4);
    expect(rows).toBe(report.declaration_lines.total);
    expect(rows).toBe(4);
  });

  it('--sessions-out: a copy of one history lists only the first file, its calls counted once', () => {
    const history = [assistant(1, [advisor('k1')]), assistant(2, [text('ADVISOR: confirm: ok')])];
    const root = makeTree('sessions-copies', { 'proj/a.jsonl': history, 'proj/b.jsonl': history });
    const { stdout, listed } = runSessions(root, 'copies');
    expect(listed.map((item) => [item.session, item.fired, item.advisor_rows])).toEqual([['a', 1, 1]]);
    expect(JSON.parse(stdout).consultations.advisor.total).toBe(1);
  });

  it('--sessions-out: a marker in text, command and file path is absent from the list and the report; only the five fields', () => {
    const root = makeTree('sessions-marker', { 'proj/s-one.jsonl': [
      assistant(1, [advisor('c1'), bash('b1', `echo ${MARKER}`)]),
      assistant(2, [text(`ADVISOR: confirm: ${MARKER}`)]),
      assistant(3, [call('w1', 'Write', { file_path: `${MARKER}/plans/${MARKER}.md` })]),
    ] });
    const { stdout, listed, target } = runSessions(root, 'marker');
    expect(readFileSync(target, 'utf8')).not.toContain(MARKER);
    expect(stdout).not.toContain(MARKER);
    expect(listed.map((item) => Object.keys(item))).toEqual([SESSION_FIELDS]);
  });

  it('--sessions-out: an existing file exits 2 and is untouched; the same path as --out exits 2; both given make two files', () => {
    const root = makeTree('sessions-exit', { 'proj/s1.jsonl': [assistant(1, [advisor('c1')])] });
    const existing = join(WORK, 'sessions-existing.json');
    writeFileSync(existing, 'keep', 'utf8');
    const first = runTool(root, ['--sessions-out', existing]);
    expect(first.code).toBe(2);
    expect(first.out).toBe('');
    expect(readFileSync(existing, 'utf8')).toBe('keep');
    const same = join(WORK, 'sessions-same.json');
    const second = runTool(root, ['--out', same, '--sessions-out', same]);
    expect(second.code).toBe(2);
    expect(second.out).toBe('');
    expect(existsSync(same)).toBe(false);
    const both = join(WORK, 'sessions-both.json');
    const reportBoth = join(WORK, 'report-both.json');
    const third = runTool(root, ['--out', reportBoth, '--sessions-out', both]);
    expect(third.code, third.err).toBe(0);
    expect(statSync(both).isFile()).toBe(true);
    expect(statSync(reportBoth).isFile()).toBe(true);
  });

  it('write errors: a missing directory and too long names exit 2 with no output and no file left; the same run then succeeds', () => {
    const root = makeTree('sessions-werr', { 'proj/s1.jsonl': [assistant(1, [advisor('c1')])] });
    const missing = join(WORK, 'no-such-dir', 'list.json');
    const reportFile = join(WORK, 'werr-report.json');
    const listedFile = join(WORK, 'werr-list.json');
    const tooLong = join(WORK, 'x'.repeat(300));
    const gone = (path: string) => {
      try { lstatSync(path); return false; } catch { return true; }
    };
    let done = runTool(root, ['--sessions-out', missing]);
    expect([done.code, done.out]).toEqual([2, '']);
    expect(done.err).toContain('cannot write --sessions-out');
    done = runTool(root, ['--out', missing]);
    expect([done.code, done.out]).toEqual([2, '']);
    expect(done.err).toContain('cannot write --out');
    done = runTool(root, ['--out', reportFile, '--sessions-out', missing]);
    expect([done.code, done.out]).toEqual([2, '']);
    expect(gone(reportFile)).toBe(true);
    done = runTool(root, ['--sessions-out', tooLong]);
    expect([done.code, done.out]).toEqual([2, '']);
    expect(gone(tooLong)).toBe(true);
    done = runTool(root, ['--out', reportFile, '--sessions-out', tooLong]);
    expect([done.code, done.out]).toEqual([2, '']);
    expect(gone(reportFile)).toBe(true);
    // the report fails after the list was written: the list is removed again
    done = runTool(root, ['--out', tooLong, '--sessions-out', listedFile]);
    expect([done.code, done.out]).toEqual([2, '']);
    expect(gone(listedFile)).toBe(true);
    done = runTool(root, ['--out', reportFile, '--sessions-out', listedFile]);
    expect(done.code, done.err).toBe(0);
    expect(statSync(listedFile).size).toBeGreaterThan(0);
    expect(statSync(reportFile).size).toBeGreaterThan(0);
  });

  it('output checks run before the input is read: an existing file, a missing directory and a symlinked duplicate exit 2', () => {
    const root = makeTree('sessions-early', { 'proj/s1.jsonl': [assistant(1, [advisor('c1')])] });
    const existing = join(WORK, 'early-existing.json');
    writeFileSync(existing, 'keep', 'utf8');
    const realDir = join(WORK, 'early-real');
    mkdirSync(realDir);
    symlinkSync(realDir, join(WORK, 'early-alias'));
    const base = ['--projects', root, '--label', LABEL];
    const attempts = [
      ['--sessions-out', existing],
      ['--sessions-out', join(WORK, 'no-such-dir', 'list.json')],
      ['--out', join(WORK, 'no-such-dir', 'report.json')],
      // the same file through a symlinked directory
      ['--out', join(realDir, 'same.json'), '--sessions-out', join(WORK, 'early-alias', 'same.json')],
    ].map((extra) => [...base, ...extra]);
    const snippet = [
      'def unreachable(args, window):',
      '    raise RuntimeError("the input was read before the output checks")',
      'module.build_report = unreachable',
      'codes = []',
      'for argv in json.loads(sys.argv[2]):',
      '    with contextlib.redirect_stderr(io.StringIO()):',
      '        codes.append(module.main(argv))',
      'print(json.dumps(codes))',
    ].join('\n');
    expect(inProcess(snippet, JSON.stringify(attempts))).toEqual([2, 2, 2, 2]);
    expect(readdirSync(realDir)).toEqual([]);
    expect(readFileSync(existing, 'utf8')).toBe('keep');
  });

  it('an encoding error after the creation removes the created file and still raises', () => {
    const target = join(WORK, 'unencodable.json');
    const snippet = [
      'raised = False',
      'try:',
      '    module.write_new_file(sys.argv[2], "bad \\udcff text")',
      'except UnicodeError:',
      '    raised = True',
      'print(json.dumps({"raised": raised, "left": os.path.lexists(sys.argv[2])}))',
    ].join('\n');
    expect(inProcess(snippet, target)).toEqual({ raised: true, left: false });
  });

  it('a byte outside UTF-8 in a directory name: exit 0, the list is ASCII JSON and the path round-trips', () => {
    const root = join(WORK, 'sessions-odd');
    const rowsText = `${JSON.stringify(assistant(1, [advisor('c1')]))}\n`;
    const directory = Buffer.concat([Buffer.from(`${root}/proj-`), Buffer.from([0xff])]);
    mkdirSync(directory, { recursive: true });
    writeFileSync(Buffer.concat([directory, Buffer.from('/s-odd.jsonl')]), rowsText, 'utf8');
    const { stdout, listed, target } = runSessions(root, 'odd');
    expect(statSync(target).size).toBeGreaterThan(0);
    expect(listed.map((item) => item.session)).toEqual(['s-odd']);
    expect([...readFileSync(target, 'utf8')].every((char) => char.charCodeAt(0) <= 127)).toBe(true);
    expect(JSON.parse(stdout).consultations.advisor.total).toBe(1);
    const snippet = 'print(json.dumps(os.path.isfile(json.load(open(sys.argv[2]))[0]["transcript"])))';
    expect(inProcess(snippet, target)).toBe(true);
  });
});
