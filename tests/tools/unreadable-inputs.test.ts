import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// An input file that is named on the command line and cannot be used stops the run: exit 2 and one message that names the
// path, with no traceback and nothing on stdout. Four ways to fail are tried for every option that names an input file:
// the file does not exist, it is a directory, it cannot be read (permission), and it is not valid UTF-8. The tests may run
// as root, for which chmod does not refuse access, so the refusal is made inside the process under test: a small harness
// replaces the file open of Python (builtins.open, io.open) or the directory listing (os.scandir, os.listdir), and a preload module
// replaces fs.readFileSync or fs.readdirSync of Node, so that one path raises EACCES. A new tool or option is one more row in ENTRIES.
const TOOLS = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'tools', 'diagnostics');
const hasPython3 = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;

const PYTHON_HARNESS = [
  'import builtins, io, os, runpy, sys',
  'mode, target, script = sys.argv[1], sys.argv[2], sys.argv[3]',
  'sys.argv = [script] + sys.argv[4:]',
  'def deny(path):',
  '    raise PermissionError(13, "Permission denied", path)',
  'if mode == "dir":',
  '    # A directory without permissions: it cannot be listed, and nothing below it can be reached (stat fails too).',
  '    real_scandir, real_listdir, real_stat = os.scandir, os.listdir, os.stat',
  '    def named(path):',
  '        return os.fspath(path) if isinstance(path, (str, os.PathLike)) else ""',
  '    def below(path):',
  '        return named(path).startswith(target + os.sep)',
  '    def scandir(path="."):',
  '        if named(path) == target or below(path):',
  '            deny(named(path))',
  '        return real_scandir(path)',
  '    def listdir(path="."):',
  '        if named(path) == target or below(path):',
  '            deny(named(path))',
  '        return real_listdir(path)',
  '    def stat(path, *args, **kwargs):',
  '        if below(path):',
  '            deny(named(path))',
  '        return real_stat(path, *args, **kwargs)',
  '    os.scandir, os.listdir, os.stat = scandir, listdir, stat',
  'elif mode == "file":',
  '    real_open = builtins.open',
  '    def opener(file, *args, **kwargs):',
  '        if isinstance(file, (str, os.PathLike)) and os.fspath(file) == target:',
  '            deny(target)',
  '        return real_open(file, *args, **kwargs)',
  '    builtins.open = io.open = opener  # Path.open goes through io.open',
  'try:',
  '    runpy.run_path(script, run_name="__main__")',
  'except SystemExit as stop:',
  '    sys.exit(stop.code)',
].join('\n');

const NODE_PRELOAD = [
  "const fs = require('node:fs');",
  'const mode = process.env.DENY_MODE;',
  'const target = process.env.DENY_PATH;',
  "const deny = (syscall) => Object.assign(new Error(`EACCES: permission denied, ${syscall} '${target}'`), { code: 'EACCES', syscall, path: target });",
  "if (mode === 'dir') {",
  '  const real = fs.readdirSync;',
  '  fs.readdirSync = function (path, ...rest) { if (String(path) === target) throw deny("scandir"); return real.call(this, path, ...rest); };',
  "} else if (mode === 'file') {",
  '  const real = fs.readFileSync;',
  '  fs.readFileSync = function (path, ...rest) { if (String(path) === target) throw deny("open"); return real.call(this, path, ...rest); };',
  '}',
  "require('node:module').syncBuiltinESMExports();",
].join('\n');

const BAD_BYTE = Buffer.from([0xff]);
const withBadByte = (before: string, after: string) => Buffer.concat([Buffer.from(before), BAD_BYTE, Buffer.from(after)]);

interface Entry {
  tool: string;
  runner: 'node' | 'python';
  option: string;
  /** The arguments of a valid run whose input file named by this option is `file`. */
  args: (file: string, base: string) => string[];
  /** A valid file for the option, and the same file with a byte that is not UTF-8 inside a string value. */
  valid: string | Buffer;
  invalid: Buffer;
}

const ROW_USER = { type: 'user', timestamp: '2026-11-14T10:00:00.000Z', sessionId: 's1', message: { role: 'user', content: 'hello' } };
const ROW_ASSISTANT = {
  type: 'assistant', timestamp: '2026-11-14T10:00:01.000Z', sessionId: 's1', requestId: 'r1',
  message: { id: 'm1', model: 'claude-test', role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1, output_tokens: 1 } },
};
const TRANSCRIPT = `${JSON.stringify(ROW_USER)}\n${JSON.stringify(ROW_ASSISTANT)}\n`;
const BAD_TRANSCRIPT = withBadByte(TRANSCRIPT.slice(0, TRANSCRIPT.indexOf('hello') + 1), TRANSCRIPT.slice(TRANSCRIPT.indexOf('hello') + 1));
const PRICES = JSON.stringify({ models: { 'claude-test': { input_per_mtok: 1, output_per_mtok: 1 } } });
const BAD_PRICES = withBadByte('{"models":{"claude-test":{"input_per_mtok":1,"output_per_mtok":1}},"note":"a', 'b"}');
const JOURNAL = '';
const BAD_JOURNAL = withBadByte('{"event":"compact","note":"a', 'b"}\n');

// Files that the runs share: a transcript, an empty compaction journal and a projects directory that holds the transcript.
let sharedTranscript = '';
let sharedJournal = '';
let sharedProjects = '';
let sharedJournalDir = '';
const PERIOD = ['--to', '2026-11-15T00:00:00Z', '--days', '7'];
const CACHE_COST = ['--deployed-at', '2026-11-01T00:00:00Z', '--to', '2026-11-15T00:00:00Z', '--days', '30', '--json'];

const DENIAL_ROW = (note: string) => `{"kind":"state","id":"0123456789abcdef","note":"${note}"}\n`;

const ENTRIES: Entry[] = [
  { tool: 'denial_log_summary.mjs', runner: 'node', option: '--file', args: (file) => ['--file', file], valid: DENIAL_ROW('ok'), invalid: withBadByte('{"kind":"state","note":"a', 'b"}\n') },
  { tool: 'denial_log_summary.mjs', runner: 'node', option: 'a plain argument', args: (file) => [file], valid: DENIAL_ROW('ok'), invalid: withBadByte('{"kind":"state","note":"a', 'b"}\n') },
  { tool: 'compaction_harm_monitor.py', runner: 'python', option: '--compact', args: (file) => ['--transcript', sharedTranscript, '--compact', file, ...PERIOD], valid: JOURNAL, invalid: BAD_JOURNAL },
  { tool: 'compaction_harm_monitor.py', runner: 'python', option: '--transcript', args: (file) => ['--transcript', file, '--compact', sharedJournal, ...PERIOD], valid: TRANSCRIPT, invalid: BAD_TRANSCRIPT },
  { tool: 'compaction_ask_probe.py', runner: 'python', option: '--compact', args: (file) => ['--transcript', sharedTranscript, '--compact', file, '--json'], valid: JOURNAL, invalid: BAD_JOURNAL },
  { tool: 'compaction_ask_probe.py', runner: 'python', option: '--transcript', args: (file) => ['--transcript', file, '--compact', sharedJournal, '--json'], valid: TRANSCRIPT, invalid: BAD_TRANSCRIPT },
  { tool: 'compaction_ask_probe.py', runner: 'python', option: '--labels', args: (file) => ['--transcript', sharedTranscript, '--compact', sharedJournal, '--json', '--labels', file], valid: JOURNAL, invalid: BAD_JOURNAL },
  { tool: 'user_prohibitions_after_compaction.py', runner: 'python', option: '--compact-log', args: (file) => ['--projects', sharedProjects, '--compact-log', file], valid: JOURNAL, invalid: BAD_JOURNAL },
  { tool: 'user_prohibitions_after_compaction.py', runner: 'python', option: '--patterns', args: (file) => ['--projects', sharedProjects, '--patterns', file], valid: '{}', invalid: withBadByte('{"permission_words":["a', 'b"]}') },
  { tool: 'compaction_window_drops.py', runner: 'python', option: '--compact', args: (file) => ['--transcript', sharedTranscript, '--compact', file], valid: JOURNAL, invalid: BAD_JOURNAL },
  { tool: 'compaction_window_drops.py', runner: 'python', option: '--transcript', args: (file) => ['--transcript', file, '--compact', sharedJournal], valid: TRANSCRIPT, invalid: BAD_TRANSCRIPT },
  { tool: 'compaction_cache_cost.py', runner: 'python', option: '--compact', args: (file) => ['--transcript', sharedTranscript, '--compact', file, ...CACHE_COST], valid: JOURNAL, invalid: BAD_JOURNAL },
  { tool: 'compaction_cache_cost.py', runner: 'python', option: '--transcript', args: (file) => ['--transcript', file, '--compact', sharedJournal, ...CACHE_COST], valid: TRANSCRIPT, invalid: BAD_TRANSCRIPT },
  { tool: 'compaction_cache_cost.py', runner: 'python', option: '--prices', args: (file) => ['--transcript', sharedTranscript, '--compact', sharedJournal, '--prices', file, ...CACHE_COST], valid: PRICES, invalid: BAD_PRICES },
  { tool: 'executor_outcome_metrics.py', runner: 'python', option: '--transcript', args: (file) => ['--transcript', file], valid: TRANSCRIPT, invalid: BAD_TRANSCRIPT },
  { tool: 'empty_results.py', runner: 'python', option: '--intent', args: (file) => ['--transcripts', sharedProjects, '--intent', file], valid: 'id\tintent\nx\tother\n', invalid: withBadByte('id\tintent\nx\tot', 'her\n') },
  { tool: 'wilson_threshold.mjs', runner: 'node', option: '--input', args: (file) => ['--input', file, '--target', '0.1'], valid: 'result\tnote\n1\tok\n0\tok\n', invalid: withBadByte('result\tnote\n1\tok\n0\tx', 'y\n') },
  { tool: 'decision_outcome_join.py', runner: 'python', option: '--prices', args: (file) => ['--journal', sharedJournalDir, '--transcripts', sharedProjects, '--prices', file], valid: '{"sonnet":[1,1,1,1,1]}', invalid: withBadByte('{"sonnet":[1,1,1,1,1],"note":"a', 'b"}') },
  { tool: '../maintenance/worktree_report.mjs', runner: 'node', option: '--repos-file', args: (file) => ['--repos-file', file], valid: '# no repositories\n', invalid: withBadByte('# a', 'b\n') },
  {
    tool: 'hook_latency_p95.mjs', runner: 'node', option: '--hooks-json', args: (file, base) => ['--dir', base, '--shell-checks-dir', base, '--hooks-json', file],
    valid: '{"hooks":{}}\n', invalid: withBadByte('{"hooks":{},"note":"a', 'b"}\n'),
  },
];

const entryOf = (tool: string) => ENTRIES.find((entry) => entry.tool === tool) as Entry;

let base = '';
let harness = '';
let preload = '';

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'unreadable-inputs-'));
  harness = join(base, 'harness.py');
  writeFileSync(harness, PYTHON_HARNESS);
  preload = join(base, 'preload.cjs');
  writeFileSync(preload, NODE_PRELOAD);
  sharedProjects = join(base, 'projects');
  mkdirSync(join(sharedProjects, 'proj'), { recursive: true });
  sharedTranscript = join(sharedProjects, 'proj', 's1.jsonl');
  writeFileSync(sharedTranscript, TRANSCRIPT);
  sharedJournalDir = join(base, 'journal');
  mkdirSync(sharedJournalDir);
  sharedJournal = join(base, 'compact.jsonl');
  writeFileSync(sharedJournal, JOURNAL);
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

type Deny = { mode: 'file' | 'dir'; path: string } | null;

function run(entry: Pick<Entry, 'tool' | 'runner'>, args: string[], deny: Deny) {
  const script = join(TOOLS, entry.tool);
  const r = entry.runner === 'python'
    ? spawnSync('python3', ['-I', '-B', harness, deny?.mode ?? 'none', deny?.path ?? '', script, ...args], { encoding: 'utf8', timeout: 120000, cwd: base })
    : spawnSync(process.execPath, [...(deny === null ? [] : ['--require', preload]), script, ...args], {
      encoding: 'utf8', timeout: 120000, cwd: base, env: { ...process.env, ...(deny === null ? {} : { DENY_MODE: deny.mode, DENY_PATH: deny.path }) },
    });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function expectStopped(r: { status: number | null; stdout: string; stderr: string }, path: string) {
  expect(r.status, r.stderr).toBe(2);
  expect(r.stderr).toContain(path);
  expect(r.stderr).not.toMatch(/Traceback|at .*\(.*:\d+:\d+\)/);
  expect(r.stdout, 'no result is printed').toBe('');
}

let counter = 0;
function fixture(label: string, content: string | Buffer): string {
  counter += 1;
  const dir = join(base, `case-${counter}-${label}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'input.jsonl');
  writeFileSync(file, content);
  return file;
}

describe.each(ENTRIES)('$tool $option names an input file', (entry) => {
  const skip = entry.runner === 'python' && !hasPython3;

  it.skipIf(skip)('control: a valid file is read', () => {
    const file = fixture('valid', entry.valid);
    const r = run(entry, entry.args(file, base), null);
    expect(r.status, r.stderr).toBe(0);
  });

  it.skipIf(skip)('a file that does not exist stops the run', () => {
    const file = join(base, `no-such-file-${counter += 1}`);
    expectStopped(run(entry, entry.args(file, base), null), file);
  });

  it.skipIf(skip)('a directory stops the run', () => {
    const file = join(base, `case-${counter += 1}-directory`);
    mkdirSync(file, { recursive: true });
    expectStopped(run(entry, entry.args(file, base), null), file);
  });

  it.skipIf(skip)('a file that cannot be read stops the run', () => {
    const file = fixture('denied', entry.valid);
    expectStopped(run(entry, entry.args(file, base), { mode: 'file', path: file }), file);
  });

  it.skipIf(skip)('a file that is not valid UTF-8 stops the run', () => {
    const file = fixture('encoding', entry.invalid);
    expectStopped(run(entry, entry.args(file, base), null), file);
  });
});

describe('denial_log_summary.mjs: a journal found in a directory that cannot be read stops the run', () => {
  it('names the file and exits 2', () => {
    const dir = join(base, 'discovered');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'denials.jsonl');
    writeFileSync(file, DENIAL_ROW('ok'));
    expectStopped(run(entryOf('denial_log_summary.mjs'), ['--dir', dir], { mode: 'file', path: file }), file);
  });

  it('names a journal that is a directory', () => {
    const dir = join(base, 'discovered-directory');
    const file = join(dir, 'denials.jsonl');
    mkdirSync(file, { recursive: true });
    expectStopped(run(entryOf('denial_log_summary.mjs'), ['--dir', dir], null), file);
  });
});

describe('hook_latency_p95.mjs: a log file in --dir that cannot be read stops the run', () => {
  it('names a log that is a directory', () => {
    const dir = join(base, 'hook-logs');
    const file = join(dir, 'hook-timing.jsonl');
    mkdirSync(file, { recursive: true });
    expectStopped(run(entryOf('hook_latency_p95.mjs'), ['--dir', dir, '--shell-checks-dir', dir], null), file);
  });
});

// The options that name an input directory. A run is stopped by a directory that does not exist, is a file, or cannot be
// listed, and by any file inside it that the run reads and that cannot be read: nothing is left out of the counts.
interface DirEntry {
  tool: string;
  runner: 'node' | 'python';
  option: string;
  /** The arguments of a valid run whose input directory named by this option is `dir`. */
  args: (dir: string) => string[];
  /** The files of a valid directory, by name; the run reads each of them. */
  files: Record<string, string>;
}

const APPLIED_ROW = `${JSON.stringify({ ts: '2026-11-14T10:00:00.500Z', point: 'learner-extraction', session_id: 's1', applied: {} })}\n`;
const DIR_ENTRIES: DirEntry[] = [
  {
    tool: 'decision_outcome_join.py', runner: 'python', option: '--journal', args: (dir) => ['--journal', dir, '--transcripts', sharedProjects],
    files: { 'applied.jsonl': APPLIED_ROW, 'applied-20261114-080000.jsonl': APPLIED_ROW, 'shadow.jsonl': '' },
  },
  {
    tool: 'jev_outcome_labels.mjs', runner: 'node', option: '--journal', args: (dir) => ['--journal', dir, '--transcripts', sharedProjects, '--json'],
    files: { 'applied.jsonl': APPLIED_ROW, 'applied-20261114-080000.jsonl': APPLIED_ROW, 'agent-type.jsonl': '' },
  },
  { tool: 'empty_results.py', runner: 'python', option: '--teams', args: (dir) => ['--teams', dir], files: {} },
];

describe.each(DIR_ENTRIES)('$tool $option names an input directory', (entry) => {
  const skip = entry.runner === 'python' && !hasPython3;
  const directory = (label: string) => {
    counter += 1;
    const dir = join(base, `dir-${counter}-${label}`);
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(entry.files)) writeFileSync(join(dir, name), content);
    return dir;
  };

  it.skipIf(skip)('control: a valid directory is read', () => {
    const r = run(entry, entry.args(directory('valid')), null);
    expect(r.status, r.stderr).toBe(0);
  });

  it.skipIf(skip)('a directory that does not exist stops the run', () => {
    const dir = join(base, `no-such-directory-${counter += 1}`);
    expectStopped(run(entry, entry.args(dir), null), dir);
  });

  it.skipIf(skip)('a file in place of the directory stops the run', () => {
    const file = fixture('not-a-directory', '');
    expectStopped(run(entry, entry.args(file), null), file);
  });

  it.skipIf(skip)('a directory that cannot be listed stops the run', () => {
    const dir = directory('denied');
    expectStopped(run(entry, entry.args(dir), { mode: 'dir', path: dir }), dir);
  });

  for (const name of Object.keys(entry.files)) {
    it.skipIf(skip)(`${name} in the directory cannot be read: the run stops`, () => {
      const dir = directory(`denied-${name}`);
      expectStopped(run(entry, entry.args(dir), { mode: 'file', path: join(dir, name) }), join(dir, name));
    });
  }
});
