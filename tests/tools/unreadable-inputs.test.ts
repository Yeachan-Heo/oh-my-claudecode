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
// replaces the file open of Python (builtins.open, io.open), and a preload module replaces fs.readFileSync of Node, so
// that one path raises EACCES. A new tool or option is one more row in ENTRIES.
const TOOLS = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'tools', 'diagnostics');
const hasPython3 = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;

const PYTHON_HARNESS = [
  'import builtins, io, os, runpy, sys',
  'target, script = sys.argv[1], sys.argv[2]',
  'sys.argv = [script] + sys.argv[3:]',
  'real_open = builtins.open',
  'def opener(file, *args, **kwargs):',
  '    if isinstance(file, (str, os.PathLike)) and os.fspath(file) == target:',
  '        raise PermissionError(13, "Permission denied", target)',
  '    return real_open(file, *args, **kwargs)',
  'builtins.open = io.open = opener  # Path.open goes through io.open',
  'try:',
  '    runpy.run_path(script, run_name="__main__")',
  'except SystemExit as stop:',
  '    sys.exit(stop.code)',
].join('\n');

const NODE_PRELOAD = [
  "const fs = require('node:fs');",
  'const target = process.env.DENY_PATH;',
  'const real = fs.readFileSync;',
  'fs.readFileSync = function (path, ...rest) {',
  "  if (String(path) === target) throw Object.assign(new Error(`EACCES: permission denied, open '${target}'`), { code: 'EACCES', syscall: 'open', path: target });",
  '  return real.call(this, path, ...rest);',
  '};',
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

const DENIAL_ROW = (note: string) => `{"kind":"state","id":"0123456789abcdef","note":"${note}"}\n`;

const ENTRIES: Entry[] = [
  { tool: 'denial_log_summary.mjs', runner: 'node', option: '--file', args: (file) => ['--file', file], valid: DENIAL_ROW('ok'), invalid: withBadByte('{"kind":"state","note":"a', 'b"}\n') },
  { tool: 'denial_log_summary.mjs', runner: 'node', option: 'a plain argument', args: (file) => [file], valid: DENIAL_ROW('ok'), invalid: withBadByte('{"kind":"state","note":"a', 'b"}\n') },
  {
    tool: 'hook_latency_p95.mjs', runner: 'node', option: '--hooks-json', args: (file, base) => ['--dir', base, '--shell-checks-dir', base, '--hooks-json', file],
    valid: '{"hooks":{}}\n', invalid: withBadByte('{"hooks":{},"note":"a', 'b"}\n'),
  },
];

let base = '';
let harness = '';
let preload = '';

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'unreadable-inputs-'));
  harness = join(base, 'harness.py');
  writeFileSync(harness, PYTHON_HARNESS);
  preload = join(base, 'preload.cjs');
  writeFileSync(preload, NODE_PRELOAD);
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

function run(entry: Entry, args: string[], deny: string | null) {
  const script = join(TOOLS, entry.tool);
  const r = entry.runner === 'python'
    ? spawnSync('python3', ['-I', '-B', harness, deny ?? '', script, ...args], { encoding: 'utf8', timeout: 120000, cwd: base })
    : spawnSync(process.execPath, [...(deny === null ? [] : ['--require', preload]), script, ...args], {
      encoding: 'utf8', timeout: 120000, cwd: base, env: { ...process.env, ...(deny === null ? {} : { DENY_PATH: deny }) },
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
    expectStopped(run(entry, entry.args(file, base), file), file);
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
    expectStopped(run(ENTRIES[0], ['--dir', dir], file), file);
  });

  it('names a journal that is a directory', () => {
    const dir = join(base, 'discovered-directory');
    const file = join(dir, 'denials.jsonl');
    mkdirSync(file, { recursive: true });
    expectStopped(run(ENTRIES[0], ['--dir', dir], null), file);
  });
});

describe('hook_latency_p95.mjs: a log file in --dir that cannot be read stops the run', () => {
  it('names a log that is a directory', () => {
    const dir = join(base, 'hook-logs');
    const file = join(dir, 'hook-timing.jsonl');
    mkdirSync(file, { recursive: true });
    expectStopped(run(ENTRIES[2], ['--dir', dir, '--shell-checks-dir', dir], null), file);
  });
});
