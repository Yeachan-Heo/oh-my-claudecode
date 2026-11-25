// Shared helpers of the five-hour guard tests (five-hour-guard.test.ts, five-hour-guard-settings.test.ts).
// Everything runs on fake usage caches and on copies of settings.json in a temporary directory. HOME, USERPROFILE and
// CLAUDE_CONFIG_DIR point into that directory too, so no test can reach a real settings file, pause file or usage cache.
// FIVE_HOUR_GUARD_TOOLS_DIR=<dir> runs the tests against another copy of the scripts (mutation checks).
import { spawn, spawnSync, type ChildProcess, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TOOLS = process.env.FIVE_HOUR_GUARD_TOOLS_DIR || join(REPO, 'tools', 'five-hour-guard');
export const GUARD = join(TOOLS, 'five-hour-guard.py');
export const HOOK = join(TOOLS, 'five-hour-guard-hook.py');
export const SETTINGS_TOOL = join(TOOLS, 'five-hour-guard-settings.py');
export const ENTRY_MODULE = join(TOOLS, 'five_hour_guard_entry.py');
export const UNIT = join(TOOLS, 'five-hour-guard.service');

const probe = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
export const HAS_PYTHON3 = probe.status === 0;
if (!HAS_PYTHON3) console.warn('five-hour guard tests are skipped: python3 is not available');
/** Absolute path of the python3 that runs the scripts (the settings tool writes it into the hook command). */
export const PYBIN = HAS_PYTHON3 ? probe.stdout.trim() : 'python3';

export const TMP = mkdtempSync(join(tmpdir(), 'five-hour-guard-'));
export const HOME_DIR = join(TMP, 'home');
export const CONFIG_DIR = join(TMP, 'claude-config');
mkdirSync(HOME_DIR, { recursive: true });
mkdirSync(CONFIG_DIR, { recursive: true });

export const ENV: NodeJS.ProcessEnv = { ...process.env, HOME: HOME_DIR, USERPROFILE: HOME_DIR, CLAUDE_CONFIG_DIR: CONFIG_DIR };
// everything the hook reads to tell that a session is not on the subscription (flags, keys, base URL, model variables): none of it may leak in from the shell that runs the tests
export const PROVIDER_ENV = ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_MODEL', 'ANTHROPIC_MODEL', 'OMC_MODEL_MEDIUM', 'CLAUDE_CODE_BEDROCK_SONNET_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'OMC_MODEL_HIGH', 'CLAUDE_CODE_BEDROCK_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'OMC_MODEL_LOW', 'CLAUDE_CODE_BEDROCK_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'];
for (const key of ['OMC_FIVE_HOUR_GUARD_CONFIG', 'CLAUDE_CODE_OAUTH_TOKEN', ...PROVIDER_ENV]) delete ENV[key];

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const now = () => Date.now() / 1000;

/** Poll until `fn` returns something truthy. The budget is generous: a busy machine slows the scripts, and the tests check behaviour, not speed. */
export async function waitFor<T>(fn: () => T, ms = 20000, what = 'condition'): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

export const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
export const readText = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : '');

const children = new Set<ChildProcess>();
export function killChildren(): void {
  for (const child of children) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}
process.on('exit', killChildren);
export function cleanup(): void {
  killChildren();
  rmSync(TMP, { recursive: true, force: true });
}

export interface Proc {
  child: ChildProcess;
  out: string;
  err: string;
  exited: boolean;
  code: number | null;
  done: Promise<Proc>;
  stop: () => Promise<void>;
}

function track(child: ChildProcess, input: string): Proc {
  children.add(child);
  const proc = { child, out: '', err: '', exited: false, code: null } as Proc;
  child.stdout?.on('data', (d) => { proc.out += d; });
  child.stderr?.on('data', (d) => { proc.err += d; });
  proc.done = new Promise<Proc>((resolve) => child.on('close', (code) => {
    proc.exited = true;
    proc.code = code;
    children.delete(child);
    resolve(proc);
  }));
  child.stdin?.on('error', () => {});
  child.stdin?.end(input);
  proc.stop = async () => {
    if (!proc.exited) child.kill('SIGKILL');
    await proc.done;
  };
  return proc;
}

/** A script in the background (the guard, the hook), the event or nothing on stdin. */
export function spawnPy(script: string, args: string[], { env = ENV, input = '' }: { env?: NodeJS.ProcessEnv; input?: string } = {}): Proc {
  return track(spawn(PYBIN, ['-I', script, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] }), input);
}

/** A hook command line run the way Claude Code runs it on Linux and macOS: through `sh -c`, the event on stdin. */
export function runCommand(command: string, sid: string): Proc {
  return track(spawn('sh', ['-c', command], { env: ENV, stdio: ['pipe', 'pipe', 'pipe'] }), hookInput(sid));
}

export function runSync(script: string, args: string[], opts: Omit<SpawnSyncOptions, 'encoding'> = {}): SpawnSyncReturns<string> {
  return spawnSync(PYBIN, ['-I', script, ...args], { encoding: 'utf8', env: ENV, timeout: 60000, ...opts });
}

/** A Python snippet in the background (`python3 -I -c`), for tests that have to reach inside a script: a wrapped function, a clock that steps. */
export function spawnPyCode(code: string, args: string[], { env = ENV }: { env?: NodeJS.ProcessEnv } = {}): Proc {
  return track(spawn(PYBIN, ['-I', '-c', code, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] }), '');
}

export function runPyCode(code: string, args: string[], opts: Omit<SpawnSyncOptions, 'encoding'> = {}): SpawnSyncReturns<string> {
  return spawnSync(PYBIN, ['-I', '-c', code, ...args], { encoding: 'utf8', env: ENV, timeout: 60000, ...opts });
}

export interface Fixture {
  dir: string;
  cache: string;
  pause: string;
  state: string;
  log: string;
  cfg: string;
  hookLog: string;
  settings: string;
}

export interface CacheOptions {
  pct: number;
  resetMs: number;
  ageMs?: number;
  extra?: Record<string, unknown>;
}

/** A usage cache entry in the shape OMC writes it (src/hud/usage-api.ts, writeCache). */
export function writeCache(f: Fixture, { pct, resetMs, ageMs = 0, extra = {} }: CacheOptions): void {
  const timestamp = Date.now() - ageMs;
  writeFileSync(f.cache, JSON.stringify({
    timestamp,
    data: { fiveHourPercent: pct, fiveHourResetsAt: new Date(resetMs).toISOString() },
    source: 'anthropic',
    lastSuccessAt: timestamp,
    ...extra,
  }), 'utf8');
}

export function fixture(name: string, { config = {}, cache }: { config?: Record<string, unknown>; cache?: CacheOptions } = {}): Fixture {
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  const f: Fixture = {
    dir,
    cache: join(dir, 'usage-cache.json'),
    pause: join(dir, 'pause.json'),
    state: join(dir, 'state.json'),
    log: join(dir, 'guard.log'),
    cfg: join(dir, 'config.json'),
    hookLog: join(dir, 'hook.log'),
    settings: join(dir, 'settings.json'),
  };
  writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, ...config }), 'utf8');
  if (cache) writeCache(f, cache);
  return f;
}

export const pauseDoc = (over: Record<string, unknown> = {}) => ({
  v: 2, paused: true, since: now(), resume_at: now() + 600, valid_until: now() + 60, exclude: [], percent: 97, pid: 1, ...over,
});
export const writePause = (f: Fixture, over: Record<string, unknown> = {}) => writeFileSync(f.pause, JSON.stringify(pauseDoc(over)), 'utf8');
export const hookInput = (sid: string) => JSON.stringify({ session_id: sid, tool_name: 'Bash' });

let hookRuns = 0;
export function startHook(f: Fixture, sid: string, { env = ENV, args = [] as string[] } = {}): Proc & { log: string } {
  const log = join(f.dir, `hook-run-${++hookRuns}.log`);
  const h = spawnPy(HOOK, ['--pause-file', f.pause, '--log', log, '--poll', '0.1', ...args], { env, input: hookInput(sid) }) as Proc & { log: string };
  h.log = log;
  return h;
}

/** The hook is held when it has logged hold-start and is still running 400 ms later. */
export async function hookHeld(f: Fixture, sid: string, opts?: { env?: NodeJS.ProcessEnv; args?: string[] }): Promise<boolean> {
  const h = startHook(f, sid, opts);
  let held = false;
  try {
    await waitFor(() => /hold-start/.test(readText(h.log)) || h.exited, 20000, 'hold-start');
    await sleep(400);
    held = !h.exited && /hold-start/.test(readText(h.log));
  } catch {
    held = false;
  }
  await h.stop();
  return held;
}

/** The hook passes when it exits 0 without output. */
export async function hookPasses(f: Fixture, sid: string, opts?: { env?: NodeJS.ProcessEnv; args?: string[] }): Promise<boolean> {
  const h = startHook(f, sid, opts);
  await Promise.race([h.done, sleep(20000)]);
  const passed = h.exited && h.code === 0 && h.out === '';
  await h.stop();
  return passed;
}

/** shlex.quote of Python: what the entry command writes around a path. */
export const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'"'"'`)}'`);

/** The hook entry command as `add` writes it, built here from the inputs (not by the code under test). */
export function generatedCommand(pause: string, hook: string, python: string, hookLog?: string): string {
  const q = shellQuote;
  return `[ -f ${q(pause)} ] && [ -f ${q(hook)} ] && [ -r ${q(hook)} ] && [ -x ${q(python)} ] || exit 0; exec ${q(python)} -I ${q(hook)} --pause-file ${q(pause)}` + (hookLog ? ` --log ${q(hookLog)}` : '');
}
