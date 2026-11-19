import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// OMC_HOOK_TIMING=1 makes scripts/run.cjs append one {ts, hook, ms} row per hook run to hook-timing.jsonl in the Jev log
// directory. Each test runs a small plugin copy in a temp dir: the real run.cjs, a control copy of it with the timing code
// cut out, trivial hook scripts, and HOME and the log directory inside the temp dir.

const REPO_ROOT = join(__dirname, '..', '..');
const RUN_CJS_SOURCE = join(REPO_ROOT, 'scripts', 'run.cjs');
const WINDOWS_SEARCH_SOURCE = join(REPO_ROOT, 'scripts', 'lib', 'windows-search.cjs');
const ROW_FILE = 'hook-timing.jsonl';
const MIB = 1024 * 1024;

const runner = (script: string, ...args: string[]) => ({
  type: 'command',
  command: 'node',
  timeout: script === 'slow-hook.mjs' ? 1 : 10,
  args: ['${CLAUDE_PLUGIN_ROOT}/scripts/run.cjs', `\${CLAUDE_PLUGIN_ROOT}/scripts/${script}`, ...args],
});
const HOOKS = {
  Stop: [
    { hooks: [runner('ok-hook.mjs', 'go')] },
    { hooks: [runner('fail-hook.mjs')] },
    { hooks: [runner('slow-hook.mjs')] },
    { hooks: [runner('wait-hook.mjs')] },
  ],
  SessionEnd: [{ hooks: [runner('session-end.mjs')] }],
  PreToolUse: [{ matcher: '*', hooks: [runner('git-guardrails.mjs')] }],
};
const WAIT_THEN_ANSWER = [
  "import { writeFileSync } from 'node:fs';",
  'if (process.env.TIMING_TEST_MARKER) {',
  "  writeFileSync(process.env.TIMING_TEST_MARKER, 'started');",
  '  await new Promise((resolve) => setTimeout(resolve, 30000));',
  '}',
  'process.stdout.write(JSON.stringify({ continue: true }));',
  '',
].join('\n');
const SCRIPTS: Record<string, string> = {
  'ok-hook.mjs': 'process.stdout.write(JSON.stringify({ continue: true }));\n',
  'fail-hook.mjs': "process.stdout.write('failing');\nprocess.exit(3);\n",
  'slow-hook.mjs': 'setTimeout(() => {}, 30000);\n',
  // with TIMING_TEST_MARKER set: announce the start, then wait to be signalled
  'wait-hook.mjs': WAIT_THEN_ANSWER,
  'session-end.mjs': 'process.stdout.write(JSON.stringify({ continue: true }));\n',
  // the session-end trust check resolves both script names, so both must exist
  'wiki-session-end.mjs': 'process.stdout.write(JSON.stringify({ continue: true }));\n',
  'git-guardrails.mjs': WAIT_THEN_ANSWER,
};

// The runner without the timing code: the function, its three calls and the switch variable removed.
function withoutTiming(source: string): string {
  const stripped = source
    .replace(/\/\/ Hook timing \(opt-in\)[\s\S]*?\nfunction startHookTiming[\s\S]*?\n}\n\n/, '')
    .split('\n')
    .filter((line) => !line.includes('hookTiming') && !line.includes('startHookTiming'))
    .join('\n');
  return stripped;
}

function makePlugin(root: string, name: string, timing: boolean): string {
  const dir = join(root, name);
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(dir, 'hooks'));
  const source = readFileSync(RUN_CJS_SOURCE, 'utf8');
  writeFileSync(join(dir, 'scripts', 'run.cjs'), timing ? source : withoutTiming(source));
  copyFileSync(WINDOWS_SEARCH_SOURCE, join(dir, 'scripts', 'lib', 'windows-search.cjs'));
  writeFileSync(join(dir, 'hooks', 'hooks.json'), JSON.stringify({ hooks: HOOKS }));
  for (const [file, text] of Object.entries(SCRIPTS)) writeFileSync(join(dir, 'scripts', file), text);
  return dir;
}

interface Run { status: number | null; stdout: string; stderr: string; pid: number | undefined }

describe('run.cjs hook timing (OMC_HOOK_TIMING)', () => {
  let root: string;
  let logs: string;
  let home: string;
  let patched: string;
  let control: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omc-run-hook-timing-'));
    logs = join(root, 'logs');
    home = join(root, 'home');
    mkdirSync(home);
    patched = makePlugin(root, 'patched', true);
    control = makePlugin(root, 'control', false);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // One run.cjs call as Claude Code makes it: node run.cjs <script path> [args]; stdin empty. HOME, the state directory and
  // the log directory always point into the temp dir, so a test never writes to the real state.
  const hookEnv = (plugin: string, env: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    OMC_STATE_DIR: join(root, 'state'),
    CLAUDE_PLUGIN_ROOT: plugin,
    OMC_JEV_LOG_DIR: logs,
    ...env,
  });

  function runHook(plugin: string, script: string, args: string[] = [], env: Record<string, string> = {}): Run {
    const r = spawnSync(process.execPath, [join(plugin, 'scripts', 'run.cjs'), join(plugin, 'scripts', script), ...args], {
      encoding: 'utf8',
      input: '',
      timeout: 20000,
      env: hookEnv(plugin, env),
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, pid: r.pid };
  }

  const rowsIn = (dir: string): Array<Record<string, unknown>> => (
    existsSync(join(dir, ROW_FILE))
      ? readFileSync(join(dir, ROW_FILE), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
      : []
  );
  const rows = () => rowsIn(logs);
  const rotatedFiles = () => readdirSync(logs).filter((f) => /^hook-timing-\d{8}-\d{6}-\d+\.jsonl$/.test(f)).sort();

  const sameOutcome = (a: Run, b: Run, what: string) => {
    expect(a.status, `${what}: exit code`).toBe(b.status);
    expect(a.stdout, `${what}: stdout`).toBe(b.stdout);
    expect(a.stderr, `${what}: stderr`).toBe(b.stderr);
  };

  it('control copy really has no timing code', () => {
    expect(readFileSync(join(control, 'scripts', 'run.cjs'), 'utf8')).not.toMatch(/hookTiming|startHookTiming|OMC_HOOK_TIMING/);
    expect(readFileSync(join(patched, 'scripts', 'run.cjs'), 'utf8')).toMatch(/startHookTiming/);
  });

  it('switch off (unset or any value but 1): no file, no log dir, same exit code and output as the runner without the code', () => {
    const base = runHook(control, 'ok-hook.mjs', ['go']);
    expect(base.status).toBe(0);
    expect(base.stdout).toBe('{"continue":true}');
    for (const value of [undefined, '', '0', 'true', 'yes', '2', ' 1', '1 ']) {
      const env: Record<string, string> = value === undefined ? {} : { OMC_HOOK_TIMING: value };
      sameOutcome(runHook(patched, 'ok-hook.mjs', ['go'], env), base, `OMC_HOOK_TIMING=${JSON.stringify(value)}`);
      expect(existsSync(logs), `no log dir for ${JSON.stringify(value)}`).toBe(false);
      expect(existsSync(join(home, '.omc')), `no default log dir for ${JSON.stringify(value)}`).toBe(false);
    }
  });

  it('switch off: failing, timed-out and worker hooks behave like the runner without the code', () => {
    const failBase = runHook(control, 'fail-hook.mjs');
    expect(failBase.status).toBe(3);
    sameOutcome(runHook(patched, 'fail-hook.mjs'), failBase, 'failing hook');
    const guardBase = runHook(control, 'git-guardrails.mjs');
    expect(guardBase.stdout).toBe('{"continue":true}');
    sameOutcome(runHook(patched, 'git-guardrails.mjs'), guardBase, 'worker hook');
    expect(existsSync(logs)).toBe(false);
  });

  it('switch on: exactly one row with ts, hook and ms; the outcome is the same as without the code', () => {
    const base = runHook(control, 'ok-hook.mjs', ['go']);
    const r = runHook(patched, 'ok-hook.mjs', ['go'], { OMC_HOOK_TIMING: '1' });
    sameOutcome(r, base, 'enabled');
    const written = rows();
    expect(written).toHaveLength(1);
    expect(Object.keys(written[0])).toEqual(['ts', 'hook', 'ms']);
    expect(written[0].ts).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(written[0].hook).toBe('ok-hook.mjs go');
    expect(Number.isInteger(written[0].ms)).toBe(true);
    expect(written[0].ms as number).toBeGreaterThanOrEqual(0);
    runHook(patched, 'ok-hook.mjs', ['go'], { OMC_HOOK_TIMING: '1' });
    expect(rows()).toHaveLength(2);
  });

  it('session-end path (a trusted SessionEnd hook) writes one row', () => {
    const base = runHook(control, 'session-end.mjs');
    const r = runHook(patched, 'session-end.mjs', [], { OMC_HOOK_TIMING: '1' });
    sameOutcome(r, base, 'session end');
    expect(base.stdout).toBe('{"continue":true}');
    expect(rows().map((x) => x.hook)).toEqual(['session-end.mjs']);
  });

  it('worker path (a trusted worker hook) writes one row and keeps the outcome', () => {
    const base = runHook(control, 'git-guardrails.mjs');
    const r = runHook(patched, 'git-guardrails.mjs', [], { OMC_HOOK_TIMING: '1' });
    sameOutcome(r, base, 'worker');
    expect(base.stdout, 'the hook really ran in the worker').toBe('{"continue":true}');
    expect(rows().map((x) => x.hook)).toEqual(['git-guardrails.mjs']);
  });

  it('hook exiting non-zero and hook hitting its time limit: same exit code as without the code, row still written', () => {
    const failBase = runHook(control, 'fail-hook.mjs');
    const fail = runHook(patched, 'fail-hook.mjs', [], { OMC_HOOK_TIMING: '1' });
    expect(failBase.status, 'the control really exits non-zero').toBe(3);
    sameOutcome(fail, failBase, 'failing hook');
    const slowBase = runHook(control, 'slow-hook.mjs');
    const slow = runHook(patched, 'slow-hook.mjs', [], { OMC_HOOK_TIMING: '1' });
    sameOutcome(slow, slowBase, 'timed-out hook');
    expect(slow.stderr, 'the time limit really fired').toMatch(/timed out/);
    const written = rows();
    expect(written.map((r) => r.hook)).toEqual(['fail-hook.mjs', 'slow-hook.mjs']);
    expect(Number.isInteger(written[1].ms)).toBe(true);
    expect(written[1].ms as number).toBeGreaterThanOrEqual(0);
  });

  it('no hook started, no row: no target, an unknown target, a guard that exits before the hook', () => {
    const env = { OMC_HOOK_TIMING: '1' };
    const none = spawnSync(process.execPath, [join(patched, 'scripts', 'run.cjs')], { encoding: 'utf8', input: '', env: hookEnv(patched, env) });
    expect(none.status).toBe(0);
    const unknown = runHook(patched, 'does-not-exist.mjs', [], env);
    sameOutcome(unknown, runHook(control, 'does-not-exist.mjs'), 'unknown target');
    const guarded = runHook(patched, 'git-guardrails.mjs', [], { ...env, OMC_GIT_GUARDRAILS: '0' });
    sameOutcome(guarded, runHook(control, 'git-guardrails.mjs', [], { OMC_GIT_GUARDRAILS: '0' }), 'disabled guard');
    expect(existsSync(join(logs, ROW_FILE)), 'none of the three wrote a row').toBe(false);
    runHook(patched, 'git-guardrails.mjs', [], env);
    expect(rows().map((r) => r.hook), 'the enabled guard does run the hook and is measured').toEqual(['git-guardrails.mjs']);
  });

  it('log dir that cannot be written: no exception, no output, same exit code', () => {
    const blocker = join(root, 'a-file');
    writeFileSync(blocker, 'x');
    const base = runHook(control, 'ok-hook.mjs', ['go']);
    const r = runHook(patched, 'ok-hook.mjs', ['go'], { OMC_HOOK_TIMING: '1', OMC_JEV_LOG_DIR: join(blocker, 'jev') });
    sameOutcome(r, base, 'unwritable dir');
    const fail = runHook(patched, 'fail-hook.mjs', [], { OMC_HOOK_TIMING: '1', OMC_JEV_LOG_DIR: join(blocker, 'jev') });
    expect(fail.status, 'a failing hook keeps its exit code when the row cannot be written').toBe(3);
    // the log path itself is a directory: the append fails
    mkdirSync(join(logs, ROW_FILE), { recursive: true });
    sameOutcome(runHook(patched, 'ok-hook.mjs', ['go'], { OMC_HOOK_TIMING: '1' }), base, 'log path is a directory');
  });

  it('default log dir is <home>/.omc/state/jev when OMC_JEV_LOG_DIR is not set', () => {
    runHook(patched, 'ok-hook.mjs', ['go'], { OMC_HOOK_TIMING: '1', OMC_JEV_LOG_DIR: '' });
    expect(rowsIn(join(home, '.omc', 'state', 'jev'))).toHaveLength(1);
  });

  const oldRow = `${JSON.stringify({ ts: '2026-11-01T00:00:00.000Z', hook: 'old.mjs', ms: 5 })}\n`;
  // a log file a little above the given number of MiB
  const writeBigLog = (mib: number) => writeFileSync(join(logs, ROW_FILE), oldRow.repeat(Math.ceil((mib * MIB) / oldRow.length) + 1));
  const timing = (env: Record<string, string> = {}) => runHook(patched, 'ok-hook.mjs', ['go'], { OMC_HOOK_TIMING: '1', ...env });

  it('rotation: with OMC_JEV_LOG_MAX_MB a larger file is renamed to hook-timing-YYYYMMDD-HHmmss-<pid>.jsonl and a new file starts', () => {
    mkdirSync(logs);
    writeBigLog(1);
    expect(statSync(join(logs, ROW_FILE)).size).toBeGreaterThan(MIB);
    const r = timing({ OMC_JEV_LOG_MAX_MB: '1' });
    const rotated = rotatedFiles();
    expect(rotated).toHaveLength(1);
    expect(rotated[0].endsWith(`-${r.pid}.jsonl`), 'the name carries the process id of the run').toBe(true);
    expect(statSync(join(logs, rotated[0])).size, 'the old rows moved to the rotated file').toBeGreaterThan(MIB);
    expect(rows().map((x) => x.hook), 'the new file holds only the new row').toEqual(['ok-hook.mjs go']);
    // a file exactly at the limit is not rotated
    writeFileSync(join(logs, ROW_FILE), `${'x'.repeat(MIB - 1)}\n`);
    timing({ OMC_JEV_LOG_MAX_MB: '1' });
    expect(rotatedFiles(), 'no second rotation at the limit').toHaveLength(1);
  });

  it('rotation is off when OMC_JEV_LOG_MAX_MB is unset or not a canonical positive integer', () => {
    mkdirSync(logs);
    writeBigLog(1.5);
    const size = statSync(join(logs, ROW_FILE)).size;
    for (const value of [undefined, '', '0', '01', '1.5', ' 1', '1 ', '+1', '-1', '1e1', 'abc', '8589934592', '9007199254740993']) {
      timing(value === undefined ? {} : { OMC_JEV_LOG_MAX_MB: value });
      expect(rotatedFiles(), `no rotation for ${JSON.stringify(value)}`).toHaveLength(0);
    }
    expect(statSync(join(logs, ROW_FILE)).size, 'the rows were only appended').toBeGreaterThan(size);
    expect(rows().filter((x) => x.hook === 'ok-hook.mjs go')).toHaveLength(13);
  }, 60000);

  it('retention: only the newest two rotated files are kept; other files in the directory stay', () => {
    mkdirSync(logs);
    const keep = ['hook-timing.jsonl.bak', 'shadow-20200101-000000-1.jsonl', 'hook-timing-20200101-000000.jsonl', 'compaction.jsonl', 'hook-timing-other.jsonl'];
    for (const name of keep) writeFileSync(join(logs, name), 'x\n');
    const stale = ['hook-timing-20200101-000000-1.jsonl', 'hook-timing-20200102-000000-2.jsonl', 'hook-timing-20200103-000000-3.jsonl'];
    for (const name of stale) writeFileSync(join(logs, name), 'x\n');
    writeBigLog(1);
    const r = timing({ OMC_JEV_LOG_MAX_MB: '1' });
    expect(r.status).toBe(0);
    const left = rotatedFiles();
    expect(left, 'two files stay: the newest old one and the one just rotated').toHaveLength(2);
    expect(left[0]).toBe('hook-timing-20200103-000000-3.jsonl');
    expect(left[1].endsWith(`-${r.pid}.jsonl`)).toBe(true);
    for (const name of keep) expect(existsSync(join(logs, name)), `${name} stays`).toBe(true);
  });

  it('a rotation or delete that fails changes neither the exit code, the output nor the row', () => {
    const base = runHook(control, 'ok-hook.mjs', ['go']);
    mkdirSync(logs);
    // oldest "rotated file" is a directory: deleting it fails
    for (const name of ['hook-timing-20200101-000000-1.jsonl', 'hook-timing-20200102-000000-2.jsonl']) mkdirSync(join(logs, name));
    writeBigLog(1);
    const r = timing({ OMC_JEV_LOG_MAX_MB: '1' });
    sameOutcome(r, base, 'failing delete');
    expect(rows().map((x) => x.hook)).toEqual(['ok-hook.mjs go']);
    // the log path is a directory: the append fails the same quiet way
    rmSync(join(logs, ROW_FILE));
    mkdirSync(join(logs, ROW_FILE));
    sameOutcome(timing({ OMC_JEV_LOG_MAX_MB: '1' }), base, 'log path is a directory');
  });

  // A signal ends the process with an 'exit' event only on the generic path, which handles SIGTERM, SIGINT and SIGHUP; the
  // worker path has no handler, so the process dies without a row.
  async function signalledRun(script: string, signal: NodeJS.Signals): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    const marker = join(root, `started-${script}-${signal}`);
    const child = spawn(process.execPath, [join(patched, 'scripts', 'run.cjs'), join(patched, 'scripts', script)], {
      env: hookEnv(patched, { OMC_HOOK_TIMING: '1', TIMING_TEST_MARKER: marker }),
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('close', (code, sig) => resolve({ code, signal: sig })));
    for (let i = 0; i < 400 && !existsSync(marker); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(marker), `${script} started`).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200)); // the runner has installed its handlers long before the hook starts
    child.kill(signal);
    return closed;
  }

  it('SIGTERM, SIGINT and SIGHUP: a row on the generic path, none on the worker path', async () => {
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
      const before = rows().length;
      await signalledRun('wait-hook.mjs', signal);
      expect(rows().length, `generic path, ${signal}: one row`).toBe(before + 1);
      expect(rows()[before].hook).toBe('wait-hook.mjs');
      const worker = await signalledRun('git-guardrails.mjs', signal);
      expect(worker.signal, `worker path, ${signal}: ended by the signal`).toBe(signal);
      expect(rows().length, `worker path, ${signal}: no row`).toBe(before + 1);
    }
  }, 60000);

  it('the hook name is one line and at most 200 characters', () => {
    runHook(patched, 'ok-hook.mjs', ['a\nb\tc', 'z'.repeat(400)], { OMC_HOOK_TIMING: '1' });
    const raw = readFileSync(join(logs, ROW_FILE), 'utf8');
    expect(raw.split('\n').filter(Boolean)).toHaveLength(1);
    const row = JSON.parse(raw) as { hook: string };
    expect(row.hook).toHaveLength(200);
    expect(row.hook.startsWith('ok-hook.mjs a b c zzz')).toBe(true);
  });

  it('the hook name is cut at 200 code points: no lone surrogate when an astral character sits at the cut', () => {
    // 'ok-hook.mjs x' is 13 characters, so a cut after 200 UTF-16 units would land in the middle of an emoji
    runHook(patched, 'ok-hook.mjs', [`x${'\u{1F600}'.repeat(400)}`], { OMC_HOOK_TIMING: '1' });
    const row = JSON.parse(readFileSync(join(logs, ROW_FILE), 'utf8')) as { hook: string };
    expect(Array.from(row.hook)).toHaveLength(200);
    expect(Buffer.from(row.hook, 'utf8').toString('utf8'), 'no lone surrogate').toBe(row.hook);
    expect(row.hook.endsWith('\u{1F600}')).toBe(true);
  });

  it('parallel runs: 20 simultaneous hooks give 20 complete rows, every line valid JSON', async () => {
    const env = hookEnv(patched, { OMC_HOOK_TIMING: '1' });
    const codes = await Promise.all(Array.from({ length: 20 }, () => new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [join(patched, 'scripts', 'run.cjs'), join(patched, 'scripts', 'ok-hook.mjs'), 'go'], { env, stdio: ['ignore', 'ignore', 'ignore'] });
      child.on('close', resolve);
    })));
    expect(codes).toEqual(Array(20).fill(0));
    const lines = readFileSync(join(logs, ROW_FILE), 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(20);
    for (const line of lines) expect(Object.keys(JSON.parse(line) as object)).toEqual(['ts', 'hook', 'ms']);
  }, 60000);
});
