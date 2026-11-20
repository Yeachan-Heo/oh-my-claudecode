import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { percentile } from '../../tools/diagnostics/hook_latency_p95.mjs';

// Tests for tools/diagnostics/hook_latency_p95.mjs on synthetic logs (temp directory only, never the real state logs).
// Covers n, p50, p95 (nearest rank), max, the per-hook, process and total limits, window filtering (days, rotated files, future
// rows), skipped rows (bad JSON, no time, negative time, other point), kind model excluded from limits and total, the hook listing
// (command text and exec form), hook-timing.jsonl rows from scripts/run.cjs, empty data and bad arguments.

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'tools', 'diagnostics', 'hook_latency_p95.mjs');
const RUN_CJS = join(ROOT, 'scripts', 'run.cjs');
const NOW = '2026-11-18T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const DAY_MS = 86_400_000;

const base = realpathSync(mkdtempSync(join(tmpdir(), 'hook-latency-p95-')));
afterAll(() => rmSync(base, { recursive: true, force: true }));

type Row = Record<string, unknown> | string;

const iso = (daysAgo: number) => new Date(NOW_MS - daysAgo * DAY_MS).toISOString();
const lines = (rows: Row[]) => `${rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n')}\n`;
const setAge = (file: string, daysAgo: number) => utimesSync(file, new Date(NOW_MS - daysAgo * DAY_MS), new Date(NOW_MS - daysAgo * DAY_MS));

// A fresh pair of directories per test: dir is the Jev log directory, shell the shell-checks directory.
let dir: string;
let shell: string;
let counter = 0;
beforeEach(() => {
  const root = join(base, `case-${++counter}`);
  dir = join(root, 'jev');
  shell = join(root, 'shell-checks');
  mkdirSync(dir, { recursive: true });
  mkdirSync(shell);
});

// HOME points into the temp directory unless a test sets it, so no run reads the real <home>/.omc/state/jev.
function run(args: string[], env: Record<string, string> = {}, cwd?: string) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd, env: { PATH: process.env.PATH ?? '', HOME: base, USERPROFILE: base, ...env } });
  const tsv = r.stdout.replace(/\n$/, '').split('\n').map((l) => l.split('\t'));
  const list = tsv.slice(1);
  const rows: Record<string, string[]> = Object.fromEntries(list.map((c) => [c[0], c]));
  return { code: r.status, stderr: r.stderr, head: tsv[0], rows, list, stdout: r.stdout };
}
const runDirs = (args: string[] = [], env: Record<string, string> = {}) => run(['--dir', dir, '--shell-checks-dir', shell, '--now', NOW, ...args], env);

const ENFORCER = 'PreToolUse:pre-tool-enforcer';
const COMPACT = 'PreCompact:jev-compaction';
const check = (daysAgo: number, durationMs: unknown, extra: Row = {}) => ({ ts: iso(daysAgo), point: 'shell-check', durationMs, ...(extra as object) });
const hundred = Array.from({ length: 100 }, (_, i) => check(1, i + 1));

describe('percentile', () => {
  it('uses the nearest-rank method', () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 0.5)).toBe(50);
    expect(percentile(v, 0.95)).toBe(95);
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([], 0.95)).toBeNull();
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
  });
});

describe('checks.jsonl and compaction.jsonl', () => {
  it('n, p50, p95 and max for 1..100 ms; a hook over the limit is flagged', () => {
    writeFileSync(join(shell, 'checks.jsonl'), lines(hundred));
    const r = runDirs();
    expect(r.code).toBe(0);
    expect(r.head).toEqual(['hook', 'source', 'kind', 'n', 'p50_ms', 'p95_ms', 'max_ms', 'flag']);
    expect(r.rows[ENFORCER].slice(1)).toEqual(['checks.jsonl:durationMs', 'partial', '100', '50', '95', '100', 'OVER']);
    expect(r.rows.TOTAL[5]).toBe('95');
    expect(r.rows.TOTAL[7]).toBe('OVER');
  });

  it('limits are parameters: a raised per-hook and total limit clears the flags', () => {
    writeFileSync(join(shell, 'checks.jsonl'), lines(hundred));
    const r = runDirs(['--hook-max-ms', '95', '--total-max-ms', '95']);
    expect(r.rows[ENFORCER][7], 'p95 equal to the limit is not over, and a partial hook never shows that it meets the limit').toBe('LOWER_BOUND_ONLY');
    expect(r.rows.TOTAL[7], 'under the limit the total is never a plain pass').toBe('PARTIAL_COVERAGE');
    expect(runDirs(['--hook-max-ms', '94.9']).rows[ENFORCER][7]).toBe('OVER');
  });

  it('total is the sum of the p95 of the measured hooks; the model hook is shown but not limited or summed', () => {
    writeFileSync(join(shell, 'checks.jsonl'), lines([check(1, 5.5), check(1, 10.5)]));
    writeFileSync(join(dir, 'compaction.jsonl'), lines([{ ts: iso(1), event: 'compact', duration_ms: 9000 }]));
    const r = runDirs();
    expect(r.rows[ENFORCER].slice(3)).toEqual(['2', '5.5', '10.5', '10.5', 'LOWER_BOUND_ONLY']);
    expect(r.rows[COMPACT].slice(2)).toEqual(['model', '1', '9000', '9000', '9000', 'n/a']);
    expect(r.rows.TOTAL[5]).toBe('10.5');
    expect(r.rows.TOTAL[3], 'n of the total row is not a call count').toBe('-');
    expect(r.rows.TOTAL[1]).toMatch(/not a call p95 and not a bound; 1 measured hooks, coverage unknown without --hooks-json$/);
    expect(r.rows.TOTAL[7]).toBe('PARTIAL_COVERAGE');
    expect(runDirs(['--total-max-ms', '10']).rows.TOTAL[7]).toBe('OVER');
  });

  it('window: older rows, future rows and stale files are ignored; rotated files inside the window are read', () => {
    writeFileSync(join(shell, 'checks.jsonl'), lines([check(8, 900), check(6.5, 10), check(0.1, 20), check(-1, 800)]));
    const rotated = [['checks-20261110-000000.jsonl', 30, 700, 30], ['checks-20261117-000000.jsonl', 2, 30, 1], ['checks-20261116-000000-4242.jsonl', 3, 40, 1]] as const;
    for (const [name, rowAge, ms, fileAge] of rotated) {
      writeFileSync(join(shell, name), lines([check(rowAge, ms)]));
      setAge(join(shell, name), fileAge);
    }
    // the mtime filter on its own: a row inside the window in a file last modified long before the window is not read
    writeFileSync(join(shell, 'checks-20261101-000000.jsonl'), lines([check(1, 4000)]));
    setAge(join(shell, 'checks-20261101-000000.jsonl'), 30);
    writeFileSync(join(shell, 'checks-notes.jsonl'), lines([check(1, 5000)]));
    const r = runDirs();
    expect(r.rows[ENFORCER].slice(3)).toEqual(['4', '20', '40', '40', 'LOWER_BOUND_ONLY']);
    expect(r.stderr).toMatch(/checks-20261116-000000-4242\.jsonl/);
    expect(runDirs(['--days', '1']).rows[ENFORCER][3]).toBe('1');
  });

  it('skipped rows: bad JSON, no ts, no time, negative or non-numeric time, other point, other event', () => {
    writeFileSync(join(shell, 'checks.jsonl'), lines(['{not json', { point: 'shell-check', durationMs: 5 }, { ts: iso(1), point: 'shell-check' }, check(1, -3), check(1, '12'), check(1, 12), { ts: iso(1), point: 'other', durationMs: 99 }]));
    writeFileSync(join(dir, 'compaction.jsonl'), lines([{ ts: iso(1), event: 'after', duration_ms: 99 }]));
    const r = runDirs();
    expect(r.rows[ENFORCER].slice(3)).toEqual(['1', '12', '12', '12', 'LOWER_BOUND_ONLY']);
    expect(r.rows[COMPACT][3]).toBe('0');
    expect(r.stderr).toMatch(/unparsable rows 2/);
    expect(r.stderr).toMatch(/rows without a usable time 3/);
    writeFileSync(join(shell, 'checks.jsonl'), lines([{ ts: 123, point: 'shell-check', durationMs: 5 }, { ts: null, point: 'shell-check', durationMs: 5 }, check(1, 5)]));
    const r2 = runDirs();
    expect(r2.stderr, 'a non-string ts is unparsable, not silently out of the window').toMatch(/unparsable rows 2;/);
    expect(r2.rows[ENFORCER][3]).toBe('1');
  });

  it('empty data: no log files or no rows give n=0, "-" and exit code 0', () => {
    const r = runDirs();
    expect(r.code).toBe(0);
    expect(r.rows[ENFORCER].slice(3)).toEqual(['0', '-', '-', '-', '']);
    expect(r.rows.TOTAL.slice(3)).toEqual(['-', '-', '-', '-', '']);
    expect(r.stderr).toMatch(/no samples in the window/);
    writeFileSync(join(shell, 'checks.jsonl'), '');
    expect(runDirs().rows[ENFORCER][3]).toBe('0');
  });
});

describe('hook listing (--hooks-json)', () => {
  it('hooks without a time are listed with n=0, from the command text and from the exec form (hooks section only)', () => {
    const hooksJson = join(dir, 'hooks.json');
    writeFileSync(hooksJson, JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node', args: ['${P}/scripts/run.cjs', '${P}/scripts/pre-tool-enforcer.mjs'] }] }],
        Stop: [{ hooks: [{ type: 'command', command: '/usr/bin/python3 -I /x/budget-guard.py' }] }],
        SubagentStart: [{ hooks: [{ type: 'command', command: 'node', args: ['${P}/scripts/run.cjs', '${P}/scripts/subagent-tracker.mjs', 'start'] }] }],
      },
      secret: 'must-not-appear',
    }));
    const r = runDirs(['--hooks-json', hooksJson]);
    expect(r.rows['Stop:budget-guard'].slice(2)).toEqual(['none', '0', '-', '-', '-', '']);
    expect(r.rows['SubagentStart:subagent-tracker'].slice(2)).toEqual(['none', '0', '-', '-', '-', '']);
    expect(r.list.filter((c) => c[0] === ENFORCER), 'measured hooks are not listed twice').toHaveLength(1);
    expect(r.rows.TOTAL[1], 'coverage with the listing (no samples here)').toMatch(/; 0 of 3 listed hooks$/);
    writeFileSync(join(shell, 'checks.jsonl'), lines([check(1, 7)]));
    expect(runDirs(['--hooks-json', hooksJson]).rows.TOTAL[1]).toMatch(/; 1 of 3 listed hooks$/);
    expect(JSON.stringify(r)).not.toContain('must-not-appear');
  });

  it('the hooks.json of the plugin lists every entry, with the enforcer once', () => {
    writeFileSync(join(shell, 'checks.jsonl'), lines([check(1, 7)]));
    const r = runDirs(['--hooks-json', join(ROOT, 'hooks', 'hooks.json')]);
    expect(r.list.filter((c) => c[0] === ENFORCER)).toHaveLength(1);
    for (const name of ['SessionEnd:session-end', 'SubagentStart:subagent-tracker', 'SubagentStop:subagent-tracker', 'Stop:persistent-mode']) {
      expect(r.rows[name]?.slice(2, 4), name).toEqual(['none', '0']);
    }
    expect(r.rows.TOTAL[1]).toMatch(/; 1 of \d+ listed hooks$/);
  });

  it('a hooks file that is not JSON exits 2 without a stack trace', () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{not json');
    const r = runDirs(['--hooks-json', bad]);
    expect(r.code).toBe(2);
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });
});

describe('configuration and bad input', () => {
  it('configuration through the environment, arguments win, bad input exits 2', () => {
    writeFileSync(join(shell, 'checks.jsonl'), lines([check(1, 50)]));
    const env = { OMC_JEV_LOG_DIR: dir, OMC_SHELL_CHECKS_LOG_DIR: shell, HOOK_LATENCY_NOW: NOW, HOOK_LATENCY_HOOK_MAX_MS: '60' };
    expect(run([], env).rows[ENFORCER][7]).toBe('LOWER_BOUND_ONLY');
    expect(run(['--hook-max-ms', '10'], env).rows[ENFORCER][7]).toBe('OVER');
    expect(run(['--dir', join(dir, 'missing'), '--now', NOW]).code).toBe(2);
    expect(run(['--dir', dir, '--shell-checks-dir', join(shell, 'missing'), '--now', NOW]).code, 'a given shell-checks dir must exist').toBe(2);
    expect(run(['--dir', dir, '--now', NOW], { OMC_SHELL_CHECKS_LOG_DIR: join(shell, 'missing') }).code, 'also when it comes from the variable').toBe(2);
    expect(run(['--dir', dir, '--days', '0']).code).toBe(2);
    expect(run(['--dir', dir, '--bogus', '1']).code).toBe(2);
    expect(run(['--dir', dir, '--now', 'not a date']).code).toBe(2);
    expect(run(['--dir', dir, '--days']).code).toBe(2);
  });

  it('--dir that is a file or an unreadable log exits 2 without a stack trace', () => {
    const file = join(dir, 'not-a-dir');
    writeFileSync(file, 'x');
    const r = run(['--dir', file, '--now', NOW]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/not a directory/);
    expect(r.stderr).not.toMatch(/\n\s+at /);
    const fileShell = run(['--dir', dir, '--shell-checks-dir', file, '--now', NOW]);
    expect(fileShell.code).toBe(2);
    expect(fileShell.stderr).toMatch(/not a directory/);
    const logs = join(dir, 'logs');
    mkdirSync(join(logs, 'compaction.jsonl'), { recursive: true });
    const r2 = run(['--dir', logs, '--shell-checks-dir', shell, '--now', NOW]);
    expect(r2.code).toBe(2);
    expect(r2.stderr).not.toMatch(/\n\s+at /);
  });

  it('default directories are the state root of the hooks: <home>/.omc without OMC_STATE_DIR, <OMC_STATE_DIR>/non-git with it', () => {
    const home = join(dir, 'home');
    const work = join(dir, 'work');
    mkdirSync(work, { recursive: true });
    // a directory outside any repository, so the state root is not the one of a checkout around the temp directory
    const env = { HOME: home, USERPROFILE: home, GIT_CEILING_DIRECTORIES: dir };
    const put = (root: string) => {
      mkdirSync(join(root, 'state', 'jev'), { recursive: true });
      mkdirSync(join(root, 'state', 'shell-checks'), { recursive: true });
      writeFileSync(join(root, 'state', 'jev', 'compaction.jsonl'), lines([{ ts: iso(1), event: 'compact', duration_ms: 33 }]));
      writeFileSync(join(root, 'state', 'shell-checks', 'checks.jsonl'), lines([check(1, 8)]));
    };
    const r0 = run(['--now', NOW], env, work);
    expect(r0.code, 'default directories that do not exist are skipped').toBe(0);
    expect(r0.rows[ENFORCER][3]).toBe('0');
    put(join(home, '.omc'));
    const r = run(['--now', NOW], env, work);
    expect(r.code, r.stderr).toBe(0);
    expect(r.rows[COMPACT].slice(3, 6)).toEqual(['1', '33', '33']);
    expect(r.rows[ENFORCER].slice(3, 6)).toEqual(['1', '8', '8']);
    const stateDir = join(dir, 'state');
    put(join(stateDir, 'non-git'));
    writeFileSync(join(stateDir, 'non-git', 'state', 'shell-checks', 'checks.jsonl'), lines([check(1, 9), check(1, 9)]));
    const r2 = run(['--now', NOW], { ...env, OMC_STATE_DIR: stateDir }, work);
    expect(r2.rows[ENFORCER].slice(3, 6), 'the state root follows OMC_STATE_DIR').toEqual(['2', '9', '9']);
  });
});

describe('--help', () => {
  it('--help and -h print the options to stdout and exit 0 without reading any log', () => {
    for (const flag of ['--help', '-h']) {
      const r = run([flag]);
      expect(r.code, flag).toBe(0);
      expect(r.stderr, `${flag}: nothing on stderr`).toBe('');
      for (const option of ['--dir', '--shell-checks-dir', '--days', '--hook-max-ms', '--process-max-ms', '--total-max-ms', '--hooks-json', '--now', '--help']) {
        expect(r.stdout, `${flag} lists ${option}`).toContain(option);
      }
      expect(r.stdout).toContain('OMC_JEV_LOG_DIR');
    }
    const late = run(['--dir', join(dir, 'missing'), '--help']);
    expect(late.code, 'the help wins over a bad directory').toBe(0);
    expect(late.stdout).toContain('usage:');
  });
});

describe('directories of hook-timing.jsonl without --dir', () => {
  const timingRows = (hook: string, values: number[]) => values.map((ms) => ({ ts: iso(1), hook, ms }));
  let home: string;
  let stateDir: string;
  let work: string;
  let env: Record<string, string>;
  const put = (where: string, name: string, rows: Row[]) => {
    mkdirSync(where, { recursive: true });
    writeFileSync(join(where, name), lines(rows));
  };
  beforeEach(() => {
    home = join(dir, 'home');
    stateDir = join(dir, 'state');
    work = join(dir, 'work');
    mkdirSync(work, { recursive: true });
    // a directory outside any repository, so the state root is <OMC_STATE_DIR>/non-git
    env = { HOME: home, USERPROFILE: home, GIT_CEILING_DIRECTORIES: dir };
  });
  const homeJev = () => join(home, '.omc', 'state', 'jev');
  const projectJev = () => join(stateDir, 'non-git', 'state', 'jev');

  it('reads the project state directory and the home directory, and says which directories and files it read', () => {
    put(projectJev(), 'hook-timing.jsonl', timingRows('a.mjs', [10, 20]));
    put(homeJev(), 'hook-timing.jsonl', timingRows('a.mjs', [40]).concat(timingRows('b.mjs', [30])));
    put(homeJev(), 'hook-timing-20261117-000000-4242.jsonl', timingRows('b.mjs', [50]));
    put(homeJev(), 'compaction.jsonl', [{ ts: iso(1), event: 'compact', duration_ms: 99 }]);
    const r = run(['--now', NOW], { ...env, OMC_STATE_DIR: stateDir }, work);
    expect(r.code, r.stderr).toBe(0);
    expect(r.rows['a.mjs'].slice(3, 7), 'rows of both directories are counted').toEqual(['3', '20', '40', '40']);
    expect(r.rows['b.mjs'].slice(3, 4)).toEqual(['2']);
    expect(r.rows[COMPACT][3], 'only hook-timing files are read from the home directory').toBe('0');
    expect(r.stderr).toContain(`directories 2: ${realpathSync(projectJev())} ${realpathSync(homeJev())}`);
    expect(r.stderr).toContain(join(projectJev(), 'hook-timing.jsonl'));
    expect(r.stderr).toContain(join(homeJev(), 'hook-timing.jsonl'));
    expect(r.stderr).toContain(join(homeJev(), 'hook-timing-20261117-000000-4242.jsonl'));
    expect(r.stderr).toMatch(/files 3:/);
  });

  it('the same directory reached twice is read once (the state root is the home directory)', () => {
    put(homeJev(), 'hook-timing.jsonl', timingRows('a.mjs', [10, 20, 30]));
    const r = run(['--now', NOW], env, work);
    expect(r.code, r.stderr).toBe(0);
    expect(r.rows['a.mjs'].slice(3, 4), 'three rows, not six').toEqual(['3']);
    expect(r.stderr).toMatch(/directories 1:/);
    expect(r.stderr).toMatch(/files 1:/);
    // the project directory is a symbolic link to the home directory: still read once
    mkdirSync(join(stateDir, 'non-git', 'state'), { recursive: true });
    symlinkSync(homeJev(), projectJev());
    const viaLink = run(['--now', NOW], { ...env, OMC_STATE_DIR: stateDir }, work);
    expect(viaLink.rows['a.mjs'].slice(3, 4), 'three rows through the link, not six').toEqual(['3']);
    expect(viaLink.stderr).toMatch(/directories 1:/);
    expect(viaLink.stderr).toMatch(/files 1:/);
  });

  it('the home directory is not read when --dir or a non-empty OMC_JEV_LOG_DIR is given; an empty variable counts as not given', () => {
    put(homeJev(), 'hook-timing.jsonl', timingRows('home.mjs', [10]));
    put(dir, 'hook-timing.jsonl', timingRows('given.mjs', [20]));
    const byOption = run(['--now', NOW, '--dir', dir], { ...env, OMC_STATE_DIR: stateDir }, work);
    expect(byOption.rows['given.mjs']).toBeTruthy();
    expect(byOption.rows['home.mjs'], '--dir: home not read').toBeUndefined();
    expect(byOption.stderr).not.toContain(homeJev());
    const byEnv = run(['--now', NOW], { ...env, OMC_STATE_DIR: stateDir, OMC_JEV_LOG_DIR: dir }, work);
    expect(byEnv.rows['given.mjs']).toBeTruthy();
    expect(byEnv.rows['home.mjs'], 'OMC_JEV_LOG_DIR: home not read').toBeUndefined();
    const empty = run(['--now', NOW], { ...env, OMC_STATE_DIR: stateDir, OMC_JEV_LOG_DIR: '' }, work);
    expect(empty.rows['home.mjs'], 'an empty OMC_JEV_LOG_DIR is the default, as in run.cjs').toBeTruthy();
    expect(empty.rows['given.mjs']).toBeUndefined();
  });
});

// hook-timing.jsonl: rows {ts, hook, ms} written by scripts/run.cjs, grouped by the hook field.
describe('hook-timing.jsonl', () => {
  const timingRows = (hook: string, n: number, ms: (i: number) => number = (i) => i + 1, day = 1) => Array.from({ length: n }, (_, i) => ({ ts: iso(day), hook, ms: ms(i) }));
  const ENFORCER_PROC = 'PreToolUse:pre-tool-enforcer (process)';
  const TRACKER_START = 'SubagentStart:subagent-tracker';

  function hooksFile(): string {
    const file = join(dir, 'hooks.json');
    const entry = (script: string, ...args: string[]) => ({ hooks: [{ type: 'command', command: 'node', args: ['${P}/scripts/run.cjs', `\${P}/scripts/${script}`, ...args] }] });
    writeFileSync(file, JSON.stringify({
      hooks: {
        PreToolUse: [entry('pre-tool-enforcer.mjs')],
        SubagentStart: [entry('subagent-tracker.mjs', 'start')],
        SubagentStop: [entry('subagent-tracker.mjs', 'stop')],
        SessionEnd: [entry('session-end.mjs')],
      },
    }));
    return file;
  }

  it('groups by the hook field, kind whole; without a process limit the flag is NO_PROCESS_LIMIT', () => {
    writeFileSync(join(dir, 'hook-timing.jsonl'), lines([...timingRows('session-end.mjs', 100), ...timingRows('subagent-tracker.mjs start', 2, () => 900)]));
    const r = runDirs();
    expect(r.code).toBe(0);
    expect(r.rows['session-end.mjs'].slice(1)).toEqual(['hook-timing.jsonl:ms', 'whole', '100', '50', '95', '100', 'NO_PROCESS_LIMIT']);
    expect(r.rows['subagent-tracker.mjs start'].slice(3)).toEqual(['2', '900', '900', '900', 'NO_PROCESS_LIMIT']);
    expect(r.stderr).toMatch(/process no limit/);
  });

  it('--process-max-ms and OMC_HOOK_PROCESS_MAX_MS judge whole-process rows; fewer than 30 samples is TOO_FEW_SAMPLES', () => {
    writeFileSync(join(dir, 'hook-timing.jsonl'), lines([...timingRows('session-end.mjs', 100), ...timingRows('wiki-session-end.mjs', 29, () => 500)]));
    const r = runDirs(['--process-max-ms', '94']);
    expect(r.rows['session-end.mjs'][7]).toBe('OVER');
    expect(runDirs(['--process-max-ms', '95']).rows['session-end.mjs'][7], 'p95 equal to the limit is not over').toBe('');
    expect(r.rows['wiki-session-end.mjs'][7]).toBe('TOO_FEW_SAMPLES');
    expect(runDirs([], { OMC_HOOK_PROCESS_MAX_MS: '94' }).rows['session-end.mjs'][7]).toBe('OVER');
    expect(runDirs(['--process-max-ms', '200'], { OMC_HOOK_PROCESS_MAX_MS: '94' }).rows['session-end.mjs'][7], 'the argument wins').toBe('');
    expect(runDirs(['--process-max-ms', '0']).code).toBe(2);
    expect(runDirs(['--process-max-ms', 'abc']).code).toBe(2);
  });

  it('the checks row keeps its --hook-max-ms comparison next to hook-timing rows', () => {
    writeFileSync(join(shell, 'checks.jsonl'), lines(hundred));
    writeFileSync(join(dir, 'hook-timing.jsonl'), lines(timingRows('session-end.mjs', 40, () => 300)));
    const r = runDirs(['--process-max-ms', '1000']);
    expect(r.rows[ENFORCER][7]).toBe('OVER');
    expect(r.rows['session-end.mjs'][7]).toBe('');
  });

  it('names come from --hooks-json by script and arguments, and the listing does not repeat them', () => {
    writeFileSync(join(dir, 'hook-timing.jsonl'), lines([...timingRows('subagent-tracker.mjs start', 3), ...timingRows('session-end.mjs', 2), ...timingRows('unlisted.mjs a b', 1)]));
    const r = runDirs(['--hooks-json', hooksFile()]);
    expect(r.rows[TRACKER_START][3]).toBe('3');
    expect(r.rows['SessionEnd:session-end'][3]).toBe('2');
    expect(r.rows['unlisted.mjs a b'][3], 'no entry for the script: the raw script and arguments').toBe('1');
    expect(r.list.filter((c) => c[0] === TRACKER_START)).toHaveLength(1);
    expect(r.list.filter((c) => c[0] === 'SessionEnd:session-end')).toHaveLength(1);
    expect(r.rows['SubagentStop:subagent-tracker'].slice(2), 'the stop entry has no samples and stays listed').toEqual(['none', '0', '-', '-', '-', '']);
    expect(r.rows[ENFORCER].slice(2, 4)).toEqual(['partial', '0']);
    expect(r.rows.TOTAL[1], 'the whole-process rows are not in the total of logic times').toMatch(/; 0 of 5 listed hooks$/);
  });

  it('a script with one entry matches by script even when the arguments differ', () => {
    writeFileSync(join(dir, 'hook-timing.jsonl'), lines(timingRows('session-end.mjs --extra', 2)));
    expect(runDirs(['--hooks-json', hooksFile()]).rows['SessionEnd:session-end'][3]).toBe('2');
  });

  it('the run.cjs row of the enforcer is named (process); the total keeps the logic time and leaves the process time out', () => {
    writeFileSync(join(shell, 'checks.jsonl'), lines([check(1, 5)]));
    writeFileSync(join(dir, 'hook-timing.jsonl'), lines([{ ts: iso(1), hook: 'pre-tool-enforcer.mjs', ms: 100 }]));
    const r = runDirs(['--hooks-json', hooksFile()]);
    expect(r.rows[ENFORCER].slice(2, 6), 'the partial row stays shown').toEqual(['partial', '1', '5', '5']);
    expect(r.rows[ENFORCER_PROC].slice(2, 6)).toEqual(['whole', '1', '100', '100']);
    expect(r.rows.TOTAL[5], 'the total sums the logic time (the shell checks), not the process time').toBe('5');
    expect(r.rows.TOTAL[1]).toMatch(/; 1 of 4 listed hooks$/);
    expect([r.rows.TOTAL_PROCESS[2], r.rows.TOTAL_PROCESS[5], r.rows.TOTAL_PROCESS[7]]).toEqual(['sum', '100', 'NO_VERDICT']);
    expect(r.rows.TOTAL_PROCESS[1]).toMatch(/information only, no limit applied.*; 1 hooks$/);
    expect(r.list.filter((c) => c[0].startsWith('PreToolUse:pre-tool-enforcer'))).toHaveLength(2);
    // without --hooks-json the script name still links the two rows
    const r2 = runDirs();
    expect(r2.rows.TOTAL[5]).toBe('5');
    expect(r2.rows.TOTAL_PROCESS[5]).toBe('100');
  });

  it('whole-process rows below the process limit never make TOTAL OVER; without such rows there is no TOTAL_PROCESS row', () => {
    writeFileSync(join(dir, 'hook-timing.jsonl'), lines([...timingRows('session-end.mjs', 40, () => 300), ...timingRows('wiki-session-end.mjs', 40, () => 350)]));
    const r = runDirs(['--process-max-ms', '1000', '--total-max-ms', '60']);
    expect([r.rows['session-end.mjs'][7], r.rows['wiki-session-end.mjs'][7]], 'both rows are under the process limit').toEqual(['', '']);
    expect(r.rows.TOTAL.slice(3), 'no logic time, so the total is empty and has no verdict').toEqual(['-', '-', '-', '-', '']);
    expect([r.rows.TOTAL_PROCESS[5], r.rows.TOTAL_PROCESS[7]], 'the sum 650 ms is above the 60 ms total limit and still gets no verdict').toEqual(['650', 'NO_VERDICT']);
    writeFileSync(join(shell, 'checks.jsonl'), lines([check(1, 20)]));
    expect(runDirs(['--process-max-ms', '1000']).rows.TOTAL[7], 'a logic row under the total limit is not pushed over by the process rows').toBe('PARTIAL_COVERAGE');
    writeFileSync(join(dir, 'hook-timing.jsonl'), '');
    expect(runDirs().rows.TOTAL_PROCESS).toBeUndefined();
  });

  it('an empty OMC_HOOK_PROCESS_MAX_MS means no process limit, like an unset one', () => {
    writeFileSync(join(dir, 'hook-timing.jsonl'), lines(timingRows('session-end.mjs', 40, () => 300)));
    const r = runDirs([], { OMC_HOOK_PROCESS_MAX_MS: '' });
    expect(r.code, r.stderr).toBe(0);
    expect(r.rows['session-end.mjs'][7]).toBe('NO_PROCESS_LIMIT');
    expect(runDirs([], { OMC_HOOK_PROCESS_MAX_MS: 'abc' }).code, 'a non-empty bad value is still an error').toBe(2);
  });

  it('rotated files and the window are read like the other logs; bad rows are counted, not grouped', () => {
    writeFileSync(join(dir, 'hook-timing.jsonl'), lines([{ ts: iso(1), hook: 'a.mjs', ms: 10 }, { ts: iso(8), hook: 'a.mjs', ms: 999 }, { ts: iso(1), hook: '', ms: 5 }, { ts: iso(1), ms: 5 }, { ts: iso(1), hook: 'a.mjs', ms: -1 }, { ts: iso(1), hook: 'a.mjs', ms: '7' }]));
    writeFileSync(join(dir, 'hook-timing-20261117-000000.jsonl'), lines([{ ts: iso(2), hook: 'a.mjs', ms: 30 }]));
    const r = runDirs();
    expect(r.rows['a.mjs'].slice(3, 7)).toEqual(['2', '10', '30', '30']);
    expect(r.stderr).toMatch(/rows without a usable time 4/);
    expect(r.stderr).toMatch(/hook-timing-20261117-000000\.jsonl/);
  });

  it('a log dir whose name contains hook-timing does not change which rows are grouped', () => {
    const odd = join(dir, 'hook-timing-dir');
    mkdirSync(odd);
    writeFileSync(join(odd, 'compaction.jsonl'), lines([{ ts: iso(1), event: 'compact', duration_ms: 20 }]));
    const r = run(['--dir', odd, '--shell-checks-dir', shell, '--now', NOW]);
    expect(r.rows[COMPACT][3]).toBe('1');
    expect(r.rows.TOTAL_PROCESS).toBeUndefined();
  });

  it('rows written by scripts/run.cjs with OMC_HOOK_TIMING=1 pass through the tool and give the hook row', () => {
    const hookDir = join(dir, 'hook-scripts');
    mkdirSync(hookDir);
    const target = join(hookDir, 'ok-hook.mjs');
    writeFileSync(target, 'process.stdout.write(JSON.stringify({ continue: true }));\n');
    const home = join(dir, 'home');
    mkdirSync(home);
    const logs = join(dir, 'written');
    for (let i = 0; i < 3; i++) {
      const r = spawnSync(process.execPath, [RUN_CJS, target, 'go'], { encoding: 'utf8', input: '', env: { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, OMC_STATE_DIR: join(dir, 'state'), OMC_JEV_LOG_DIR: logs, OMC_HOOK_TIMING: '1' } });
      expect(r.status, r.stderr).toBe(0);
    }
    const hooks = join(dir, 'plugin-hooks.json');
    writeFileSync(hooks, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node', args: ['${P}/scripts/run.cjs', '${P}/scripts/ok-hook.mjs', 'go'] }] }] } }));
    const r = run(['--dir', logs, '--shell-checks-dir', shell, '--hooks-json', hooks]);
    expect(r.code, r.stderr).toBe(0);
    const row = r.rows['Stop:ok-hook'];
    expect(row, r.stdout).toBeTruthy();
    expect([row[1], row[2], row[3], row[7]]).toEqual(['hook-timing.jsonl:ms', 'whole', '3', 'NO_PROCESS_LIMIT']);
    expect(Number.isFinite(Number(row[5]))).toBe(true);
    expect(Number(row[5])).toBeGreaterThanOrEqual(0);
    expect(r.list.filter((c) => c[0] === 'Stop:ok-hook'), 'listed once').toHaveLength(1);
  });
});

describe('long inputs', () => {
  it('300000 rows of one hook in hook-timing.jsonl are counted: the samples are not spread into a call', () => {
    const count = 300_000;
    const stamp = iso(1);
    const rows = Array.from({ length: count }, (_, i) => `{"ts":"${stamp}","hook":"a.mjs","ms":${i % 1000}}`);
    writeFileSync(join(dir, 'hook-timing.jsonl'), `${rows.join('\n')}\n`);
    const started = Date.now();
    const r = runDirs();
    expect(r.code, r.stderr).toBe(0);
    // n, p50, p95, max of the values 0..999 repeated 300 times
    expect(r.rows['a.mjs'].slice(3, 7)).toEqual(['300000', '499', '949', '999']);
    expect(Date.now() - started, 'read in a reasonable time').toBeLessThan(30_000);
  }, 120_000);
});
