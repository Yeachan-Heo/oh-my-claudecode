import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORDER = resolve(HERE, '../../../scripts/record-pane-frames.mjs');
const HAS_TMUX = process.platform !== 'win32' && spawnSync('tmux', ['-V']).status === 0;

const PROVIDER_SOURCE = `
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
writeFileSync(process.argv[2], String(process.pid));
const settingsAt = process.argv.indexOf('--settings');
if (settingsAt > 0) {
  const { hooks } = JSON.parse(readFileSync(process.argv[settingsAt + 1], 'utf8'));
  for (const input of [{ hook_event_name: 'SessionStart' }, { hook_event_name: 'Stop', stop_hook_active: true }]) {
    execSync(hooks[input.hook_event_name][0].hooks[0].command, { input: JSON.stringify(input) });
  }
}
if (process.argv.includes('--scroll')) for (let line = 1; line <= 30; line += 1) console.log('scrolled-' + line + '.');
console.log('=== test results ===');
console.log('size:' + process.stdout.columns + 'x' + process.stdout.rows);
console.log('READY>');
createInterface({ input: process.stdin }).on('line', (line) => {
  if (line === 'quit') process.exit(0);
  console.log('got:' + line);
});
`;

interface RecorderRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

let root = '';

beforeEach(() => {
  // A unix socket path is capped near 104 bytes, which macOS's tmpdir() nearly fills.
  root = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'rpf-'));
});

afterEach(() => {
  for (const socket of leftoverSockets()) spawnSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' });
  rmSync(root, { recursive: true, force: true });
});

function leftoverSockets(): string[] {
  return readdirSync(root)
    .filter(name => name.startsWith('tmux-'))
    .flatMap(dir => readdirSync(join(root, dir)).map(name => join(root, dir, name)));
}

function runRecorder(args: string[], whileRunning?: () => Promise<void>, cwd?: string): Promise<RecorderRun> {
  const env: NodeJS.ProcessEnv = { ...process.env, TMUX_TMPDIR: root };
  delete env.TMUX;
  const child = spawn(process.execPath, [RECORDER, ...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const exited = new Promise<RecorderRun>((resolveRun, reject) => {
    child.on('error', reject);
    child.on('close', code => resolveRun({ code, stdout, stderr }));
  });
  if (!whileRunning) return exited;
  return whileRunning().then(() => exited, async (error) => {
    child.kill('SIGKILL');
    await exited;
    throw error;
  });
}

async function until<T>(read: () => T | undefined | false | null, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(done => setTimeout(done, 20));
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('record-pane-frames extract', () => {
  function extract(from: string, ...extra: string[]): RecorderRun & { corpus: string } {
    const corpus = join(root, 'corpus');
    const result = spawnSync(process.execPath, [
      RECORDER, 'extract', '--from', from, '--state', 'idle', '--provider', 'claude', '--version', '1.0.0',
      '--corpus', corpus, ...extra,
    ], { encoding: 'utf8' });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr, corpus };
  }

  it('keeps a pane line that starts with "=== " inside its frame', () => {
    const from = join(root, 'frames.txt');
    const second = 'building\n=== test results ===\n3 passed\n> \n';
    writeFileSync(from, `=== 1763340000.100\nfirst\n=== 1763340000.250\n${second}`);

    const last = extract(from);
    expect(last.code).toBe(0);
    expect(readFileSync(join(last.corpus, 'claude/1.0.0/idle.txt'), 'utf8')).toBe(second);

    expect(extract(from, '--frame', '0').code).toBe(0);
    expect(readFileSync(join(last.corpus, 'claude/1.0.0/idle.txt'), 'utf8')).toBe('first\n');
  });

  it('files a plain text file that starts with "=== " as one frame', () => {
    const from = join(root, 'plain.txt');
    const text = '=== summary ===\nall good\n> \n';
    writeFileSync(from, text);

    const result = extract(from);
    expect(result.code).toBe(0);
    expect(readFileSync(join(result.corpus, 'claude/1.0.0/idle.txt'), 'utf8')).toBe(text);
  });

  it('replaces the manifest entry for a state instead of adding a second one', () => {
    const from = join(root, 'frames.txt');
    writeFileSync(from, '=== 1763340000.100\nfirst\n=== 1763340000.250\nsecond\n');

    const first = extract(from, '--frame', '0', '--note', 'old');
    extract(from, '--frame', '1', '--cols', '80');

    const manifest = JSON.parse(readFileSync(join(first.corpus, 'manifest.json'), 'utf8')) as Array<Record<string, unknown>>;
    expect(manifest).toHaveLength(1);
    expect(manifest[0]).toMatchObject({ file: 'claude/1.0.0/idle.txt', state: 'idle', cols: 80, source: 'recorded' });
    expect(manifest[0]).not.toHaveProperty('note');
    expect(String(manifest[0]!.origin)).toMatch(/frames\.txt#1$/);
  });

  it('leaves the fixture and the manifest alone when --args is refused', () => {
    const from = join(root, 'frames.txt');
    writeFileSync(from, '=== 1763340000.100\nfirst\n=== 1763340000.250\nsecond\n');
    const filed = extract(from, '--frame', '0');
    const manifestPath = join(filed.corpus, 'manifest.json');
    const manifestBefore = readFileSync(manifestPath, 'utf8');

    const refused = extract(from, '--frame', '1', '--args', 'not json');

    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('--args must be a JSON array of strings');
    expect(readFileSync(join(filed.corpus, 'claude/1.0.0/idle.txt'), 'utf8')).toBe('first\n');
    expect(readFileSync(manifestPath, 'utf8')).toBe(manifestBefore);
  });

  it('refuses a frame index the recording does not have', () => {
    const from = join(root, 'frames.txt');
    writeFileSync(from, '=== 1763340000.100\nonly\n');

    const result = extract(from, '--frame', '4');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--frame 4 is out of range (0..0)');
    expect(existsSync(join(result.corpus, 'manifest.json'))).toBe(false);
  });
});

const CONTRACT_STUB_SOURCE = `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
if (process.argv[2] === '--version') {
  console.log('stub 9.8.7');
  process.exit(0);
}
writeFileSync(new URL('./argv.json', import.meta.url), JSON.stringify(process.argv.slice(2)));
console.log('READY>');
setInterval(() => {}, 1000);
`;

describe.skipIf(!HAS_TMUX)('record-pane-frames record', () => {
  let pidFile = '';
  let out = '';

  function record(
    steps: string[],
    extra: string[] = [],
    whileRunning?: () => Promise<void>,
    launch: { provider?: string; args?: string[] } = {},
  ): Promise<RecorderRun> {
    const provider = join(root, 'provider.mjs');
    pidFile = join(root, 'provider.pid');
    out = join(root, 'out');
    writeFileSync(provider, PROVIDER_SOURCE);
    return runRecorder([
      'record', '--provider', launch.provider ?? 'claude', '--bin', process.execPath,
      '--args', JSON.stringify([provider, pidFile, ...(launch.args ?? [])]),
      '--out', out, '--cwd', root, '--interval-ms', '20', '--settle', '0.3', '--timeout', '20',
      ...extra, ...steps.flatMap(step => ['--step', step]),
    ], whileRunning);
  }

  const providerPid = () => until(() => existsSync(pidFile) && Number(readFileSync(pidFile, 'utf8')), 'the provider to start');
  const actions = () => readFileSync(join(out, 'actions.log'), 'utf8').trim().split('\n').map(line => line.replace(/^\S+ /, ''));

  it('runs its steps in order, settles, and leaves no tmux server', async () => {
    const steps = ['wait:READY>', 'text:hello', 'keys:Enter', 'wait:got:hello', 'sleep:0.1'];
    const run = await record(steps);

    expect(run.code).toBe(0);
    const summary = JSON.parse(run.stdout) as { stop: string; frames: number; out: string };
    expect(summary.stop).toBe('settled');
    expect(summary.frames).toBeGreaterThanOrEqual(2);
    expect(actions()).toEqual(['launch', ...steps]);
    expect(leftoverSockets()).toEqual([]);
    expect(processIsAlive(await providerPid())).toBe(false);

    const { frame } = extractLast();
    expect(frame).toContain('=== test results ===');
    expect(frame).toContain('READY>');
    expect(frame).toContain('got:hello');
  });

  it('without steps, records until the settle time passes and leaves no tmux server', async () => {
    const run = await record([], ['--settle', '2', '--timeout', '10']);

    expect(run.code).toBe(0);
    const summary = JSON.parse(run.stdout) as { stop: string; frames: number };
    expect(summary.stop).toBe('settled');
    expect(summary.frames).toBeGreaterThanOrEqual(1);
    expect(actions()).toEqual(['launch']);
    expect(extractLast().frame).toContain('READY>');
    expect(leftoverSockets()).toEqual([]);
    expect(processIsAlive(await providerPid())).toBe(false);
  });

  it('stops with pane_dead when the provider exits and names the step it never reached', async () => {
    const run = await record(['wait:READY>', 'text:quit', 'keys:Enter', 'wait:never-shown']);

    expect(run.code).toBe(0);
    expect((JSON.parse(run.stdout) as { stop: string }).stop).toBe('pane_dead');
    expect(run.stderr).toContain('stopped before step wait:never-shown');
    expect(readFileSync(join(out, 'frames.txt'), 'utf8')).toContain('READY>');
    expect(leftoverSockets()).toEqual([]);
  });

  it('stops with timeout when a wait step never matches', async () => {
    const run = await record(['wait:never-shown'], ['--timeout', '1']);

    expect(run.code).toBe(0);
    expect((JSON.parse(run.stdout) as { stop: string }).stop).toBe('timeout');
    expect(run.stderr).toContain('stopped before step wait:never-shown');
    expect(leftoverSockets()).toEqual([]);
    expect(processIsAlive(await providerPid())).toBe(false);
  });

  function extractLast(): { frame: string; entry: Record<string, unknown> } {
    const corpus = join(root, 'corpus');
    const extracted = spawnSync(process.execPath, [RECORDER, 'extract', '--from', join(out, 'frames.txt'), '--state', 'idle', '--corpus', corpus], { encoding: 'utf8' });
    expect(extracted.status).toBe(0);
    const [entry] = JSON.parse(readFileSync(join(corpus, 'manifest.json'), 'utf8')) as Array<Record<string, unknown>>;
    return { frame: readFileSync(join(corpus, extracted.stdout.trim()), 'utf8'), entry: entry! };
  }

  it('gives the pane the --cols and --rows it was asked for and files them with the frame', async () => {
    const run = await record(['wait:READY>'], ['--cols', '70', '--rows', '12']);

    expect(run.code).toBe(0);
    const { frame, entry } = extractLast();
    expect(frame).toContain('size:70x12');
    expect(entry).toMatchObject({ cols: 70, rows: 12 });
    expect(entry).not.toHaveProperty('hooks');
  });

  it('captures scrolled-off lines only with --history', async () => {
    const size = ['--cols', '70', '--rows', '12'];
    expect((await record(['wait:READY>'], size, undefined, { args: ['--scroll'] })).code).toBe(0);
    const visibleOnly = extractLast().frame;
    expect(visibleOnly).toContain('scrolled-30.');
    expect(visibleOnly).not.toContain('scrolled-1.');

    expect((await record(['wait:READY>'], [...size, '--history', '80'], undefined, { args: ['--scroll'] })).code).toBe(0);
    const withHistory = extractLast().frame;
    expect(withHistory).toContain('scrolled-1.');
    expect(withHistory).toContain('scrolled-30.');
    expect(withHistory).toContain('READY>');
  });

  it('launches with the model contract args and records the binary version when --args is omitted', async () => {
    const stub = join(root, 'stub-claude.mjs');
    writeFileSync(stub, CONTRACT_STUB_SOURCE);
    chmodSync(stub, 0o755);
    out = join(root, 'out');

    const run = await runRecorder([
      'record', '--provider', 'claude', '--bin', stub, '--out', out, '--cwd', root,
      '--interval-ms', '20', '--settle', '0.3', '--timeout', '20', '--step', 'wait:READY>',
    ]);

    expect(run.code).toBe(0);
    const summary = JSON.parse(run.stdout) as { version: string; launch_args: string[] };
    expect(summary.version).toBe('9.8.7');
    expect(summary.launch_args.length).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(join(root, 'argv.json'), 'utf8'))).toEqual(summary.launch_args);
    expect(extractLast().entry).toMatchObject({ provider: 'claude', version: '9.8.7', launch_args: summary.launch_args });
  });

  it('passes --model through the model contract to the provider and the manifest entry', async () => {
    const stub = join(root, 'stub-codex.mjs');
    writeFileSync(stub, CONTRACT_STUB_SOURCE);
    chmodSync(stub, 0o755);
    out = join(root, 'out');

    const run = await runRecorder([
      'record', '--provider', 'codex', '--model', 'stub-model-1', '--bin', stub, '--out', out, '--cwd', root,
      '--interval-ms', '20', '--settle', '0.3', '--timeout', '20', '--step', 'wait:READY>',
    ]);

    expect(run.code).toBe(0);
    const argv = JSON.parse(readFileSync(join(root, 'argv.json'), 'utf8')) as string[];
    expect(argv[argv.indexOf('--model') + 1]).toBe('stub-model-1');
    expect(extractLast().entry).toMatchObject({ provider: 'codex', launch_args: argv });
  });

  it('launches a relative --bin from the directory the recorder was started in', async () => {
    writeFileSync(join(root, 'stub-claude.mjs'), CONTRACT_STUB_SOURCE);
    chmodSync(join(root, 'stub-claude.mjs'), 0o755);
    const paneCwd = join(root, 'pane-cwd');
    mkdirSync(paneCwd);
    out = join(root, 'out');

    const run = await runRecorder([
      'record', '--provider', 'claude', '--bin', './stub-claude.mjs', '--args', '["--flag"]', '--out', out, '--cwd', paneCwd,
      '--interval-ms', '20', '--settle', '0.3', '--timeout', '20', '--step', 'wait:READY>',
    ], undefined, root);

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ stop: 'settled', version: '9.8.7' });
    expect(JSON.parse(readFileSync(join(root, 'argv.json'), 'utf8'))).toEqual(['--flag']);
  });

  it('starts a reused --out directory from empty logs', async () => {
    await record(['wait:READY>'], ['--hooks']);
    const run = await record(['wait:READY>', 'sleep:0.1']);

    expect(run.code).toBe(0);
    expect(actions()).toEqual(['launch', 'wait:READY>', 'sleep:0.1']);
    expect(existsSync(join(out, 'hook-events.log'))).toBe(false);
    expect(JSON.parse(readFileSync(join(out, 'meta.json'), 'utf8'))).toMatchObject({ hooks: false });
  });

  it('with --hooks, passes the provider settings whose hooks log each event', async () => {
    const run = await record(['wait:READY>'], ['--hooks']);

    expect(run.code).toBe(0);
    const settings = JSON.parse(readFileSync(join(out, 'hook-settings.json'), 'utf8')) as { hooks: Record<string, unknown> };
    expect(Object.keys(settings.hooks)).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop']);
    const events = readFileSync(join(out, 'hook-events.log'), 'utf8').trim().split('\n');
    expect(events.map(line => line.replace(/^\d+\.\d{3} /, ''))).toEqual(['SessionStart', 'Stop stop_hook_active']);
    expect(JSON.parse(readFileSync(join(out, 'meta.json'), 'utf8'))).toMatchObject({ hooks: true });
    expect(extractLast().entry).toMatchObject({ hooks: true });
  });

  it.each([
    { name: 'a provider other than claude', launch: { provider: 'codex' }, message: '--hooks is only supported for claude' },
    { name: 'claude under --bare', launch: { args: ['--bare'] }, message: '--hooks cannot record under --bare' },
  ])('refuses --hooks for $name before it starts tmux', async ({ launch, message }) => {
    const run = await record([], ['--hooks'], undefined, launch);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain(message);
    expect(existsSync(pidFile)).toBe(false);
    expect(leftoverSockets()).toEqual([]);
  });

  it('fails and removes the socket when its tmux server dies mid-run', async () => {
    const run = await record(['wait:never-shown'], [], async () => {
      await providerPid();
      const [socket] = await until(() => { const found = leftoverSockets(); return found.length > 0 && found; }, 'the tmux socket');
      spawnSync('tmux', ['-S', socket!, 'kill-server'], { stdio: 'ignore' });
    });

    expect(run.code).not.toBe(0);
    expect(run.stdout).toBe('');
    expect(leftoverSockets()).toEqual([]);
  });

  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)('kills its tmux server and the provider on %s', async (signal) => {
    let pid = 0;
    let recorderPid = 0;
    const run = await record(['wait:never-shown'], [], async () => {
      pid = await providerPid();
      recorderPid = Number(/pane-frames-(\d+)-/.exec(leftoverSockets()[0] ?? '')?.[1]);
      process.kill(recorderPid, signal);
    });

    expect(recorderPid).toBeGreaterThan(0);
    expect(run.code).toBe(128 + { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[signal]);
    expect(leftoverSockets()).toEqual([]);
    await until(() => !processIsAlive(pid), 'the provider to exit');
  });
});
