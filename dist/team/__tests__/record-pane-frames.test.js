import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
const HERE = dirname(fileURLToPath(import.meta.url));
const RECORDER = resolve(HERE, '../../../scripts/record-pane-frames.mjs');
const TMUX_PATH = process.platform === 'win32' ? '' : spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim();
const HAS_TMUX = TMUX_PATH !== '' && spawnSync(TMUX_PATH, ['-V']).status === 0;
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
let root = '';
beforeEach(() => {
    // A unix socket path is capped near 104 bytes, which macOS's tmpdir() nearly fills.
    root = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'rpf-'));
});
afterEach(() => {
    for (const socket of leftoverSockets())
        spawnSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' });
    rmSync(root, { recursive: true, force: true });
});
function leftoverSockets() {
    return readdirSync(root)
        .filter(name => name.startsWith('tmux-'))
        .flatMap(dir => readdirSync(join(root, dir)).map(name => join(root, dir, name)));
}
function runRecorder(args, whileRunning, spawnOptions = {}) {
    const env = { ...process.env, TMUX_TMPDIR: root, ...spawnOptions.env };
    delete env.TMUX;
    // The model contract refuses some providers under the developer's own security mode.
    delete env.OMC_SECURITY;
    const child = spawn(process.execPath, [RECORDER, ...args], { env, cwd: spawnOptions.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const exited = new Promise((resolveRun, reject) => {
        child.on('error', reject);
        child.on('close', code => resolveRun({ code, stdout, stderr }));
    });
    if (!whileRunning)
        return exited;
    return whileRunning().then(() => exited, async (error) => {
        child.kill('SIGKILL');
        await exited;
        throw error;
    });
}
async function until(read, what, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = read();
        if (value)
            return value;
        if (Date.now() > deadline)
            throw new Error(`timed out waiting for ${what}`);
        await new Promise(done => setTimeout(done, 20));
    }
}
function processIsAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
describe('record-pane-frames extract', () => {
    function extract(from, ...extra) {
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
        const manifest = JSON.parse(readFileSync(join(first.corpus, 'manifest.json'), 'utf8'));
        expect(manifest).toHaveLength(1);
        expect(manifest[0]).toMatchObject({ file: 'claude/1.0.0/idle.txt', state: 'idle', cols: 80, source: 'recorded' });
        expect(manifest[0]).not.toHaveProperty('note');
        expect(String(manifest[0].origin)).toMatch(/frames\.txt#1$/);
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
    it.each(['migrated', 'synthetic'])('files a %s frame with the origin and note it was given', (source) => {
        const from = join(root, 'plain.txt');
        writeFileSync(from, '> \n');
        const result = extract(from, '--source', source, '--origin', 'tmux-session.test.ts', '--note', 'idle prompt');
        expect(result.code).toBe(0);
        const [entry] = JSON.parse(readFileSync(join(result.corpus, 'manifest.json'), 'utf8'));
        expect(entry).toMatchObject({ source, origin: 'tmux-session.test.ts', note: 'idle prompt', cols: null, rows: null, launch_args: null });
    });
    it.each([
        { name: 'an unknown --source', args: ['--source', 'copied'], message: '--source must be one of recorded, migrated, synthetic' },
        { name: 'a --state that is not kebab-case', args: ['--state', 'Idle Prompt'], message: '--state must be kebab-case' },
    ])('refuses $name and writes nothing', ({ args, message }) => {
        const from = join(root, 'plain.txt');
        writeFileSync(from, '> \n');
        const result = extract(from, ...args);
        expect(result.code).toBe(2);
        expect(result.stderr).toContain(message);
        expect(existsSync(result.corpus)).toBe(false);
    });
    it.each([
        { name: 'a --provider that names a path', args: ['--provider', '../escaped'], message: '--provider must be a single name' },
        { name: 'a --version that names a path', args: ['--version', '..'], message: '--version must be a single name' },
        { name: 'a --version with a separator', args: ['--version', '1.0/../../escaped'], message: '--version must be a single name' },
        { name: 'a --cols that is not a number', args: ['--cols', 'oops'], message: '--cols must be an integer of at least 1' },
        { name: 'an empty --frame', args: ['--frame', ''], message: '--frame must be an integer of at least 0' },
        { name: 'a fractional --frame', args: ['--frame', '0.5'], message: '--frame must be an integer of at least 0' },
    ])('refuses $name and writes nothing', ({ args, message }) => {
        const from = join(root, 'plain.txt');
        writeFileSync(from, '> \n');
        const result = extract(from, ...args);
        expect(result.code).toBe(2);
        expect(result.stderr).toContain(message);
        expect(readdirSync(root)).toEqual(['plain.txt']);
    });
    it('refuses a meta.json whose provider would file the frame outside the corpus', () => {
        const recording = join(root, 'recording');
        mkdirSync(recording);
        writeFileSync(join(recording, 'frames.txt'), '=== 1763340000.100\n> \n');
        writeFileSync(join(recording, 'meta.json'), JSON.stringify({ provider: '../../escaped', version: '1.0.0' }));
        const corpus = join(root, 'corpus');
        const result = spawnSync(process.execPath, [RECORDER, 'extract', '--from', join(recording, 'frames.txt'), '--state', 'idle', '--corpus', corpus], { encoding: 'utf8' });
        expect(result.status).toBe(2);
        expect(result.stderr).toContain('--provider must be a single name');
        expect(readdirSync(root)).toEqual(['recording']);
    });
    it('needs --provider and --version when the recording has no meta.json', () => {
        const from = join(root, 'plain.txt');
        writeFileSync(from, '> \n');
        const corpus = join(root, 'corpus');
        const base = [RECORDER, 'extract', '--from', from, '--state', 'idle', '--corpus', corpus];
        const noProvider = spawnSync(process.execPath, [...base, '--version', '1.0.0'], { encoding: 'utf8' });
        const noVersion = spawnSync(process.execPath, [...base, '--provider', 'claude'], { encoding: 'utf8' });
        expect(noProvider.status).toBe(2);
        expect(noProvider.stderr).toContain('--provider is required without meta.json');
        expect(noVersion.status).toBe(2);
        expect(noVersion.stderr).toContain('--version is required without meta.json');
        expect(existsSync(corpus)).toBe(false);
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
describe('record-pane-frames arguments', () => {
    it.each([
        { name: 'an unknown step kind', args: ['record', '--provider', 'claude', '--step', 'typo:x'], message: 'unknown --step typo:x' },
        { name: 'a negative sleep', args: ['record', '--provider', 'claude', '--step', 'sleep:-1'], message: 'unknown --step sleep:-1' },
        { name: 'a sleep that is not a number', args: ['record', '--provider', 'claude', '--step', 'sleep:soon'], message: 'unknown --step sleep:soon' },
        { name: 'a sleep that never ends', args: ['record', '--provider', 'claude', '--step', 'sleep:Infinity'], message: 'unknown --step sleep:Infinity' },
        { name: 'a pane with no columns', args: ['record', '--provider', 'claude', '--cols', '0'], message: '--cols must be an integer of at least 1' },
        { name: 'a fractional row count', args: ['record', '--provider', 'claude', '--rows', '12.5'], message: '--rows must be an integer of at least 1' },
        { name: 'a negative history', args: ['record', '--provider', 'claude', '--history=-1'], message: '--history must be an integer of at least 0' },
        { name: 'a zero interval', args: ['record', '--provider', 'claude', '--interval-ms', '0'], message: '--interval-ms must be a number of at least 1' },
        { name: 'a timeout that is not a number', args: ['record', '--provider', 'claude', '--timeout', 'NaN'], message: '--timeout must be a number of at least 0' },
        { name: 'an empty settle time', args: ['record', '--provider', 'claude', '--settle', ''], message: '--settle must be a number of at least 0' },
        { name: 'a --cwd that is a file', args: ['record', '--provider', 'claude', '--cwd', '<a file>'], message: 'is not a directory' },
        { name: 'a --cwd that does not exist', args: ['record', '--provider', 'claude', '--cwd', '<missing>'], message: 'is not a directory' },
        { name: 'record without --provider', args: ['record'], message: '--provider is required' },
        { name: 'an unknown command', args: ['replay'], message: 'unknown command replay' },
        { name: 'no command', args: [], message: 'unknown command <none>' },
    ])('refuses $name before it records anything', async ({ args, message }) => {
        const out = join(root, 'out');
        // A binary that does not exist, so a recorder that stops refusing launches no real provider.
        const safe = ['--out', out, '--bin', join(root, 'no-such-provider'), '--args', '[]', '--settle', '0', '--timeout', '2'];
        writeFileSync(join(root, 'a-file'), '');
        const given = args.map(arg => (arg === '<a file>' ? join(root, 'a-file') : arg === '<missing>' ? join(root, 'missing') : arg));
        const run = await runRecorder(given[0] === 'record' ? ['record', ...safe, ...given.slice(1)] : given);
        expect(run.code).toBe(2);
        expect(run.stderr).toContain(message);
        expect(run.stdout).toBe('');
        expect(existsSync(out)).toBe(false);
        expect(leftoverSockets()).toEqual([]);
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
    function record(steps, extra = [], whileRunning, launch = {}) {
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
    const providerHasExited = async () => {
        const pid = await providerPid();
        await until(() => !processIsAlive(pid), 'the provider to exit');
    };
    const actions = () => readFileSync(join(out, 'actions.log'), 'utf8').trim().split('\n').map(line => line.replace(/^\S+ /, ''));
    it('runs its steps in order, settles, and leaves no tmux server', async () => {
        const steps = ['wait:READY>', 'text:hello', 'keys:Enter', 'wait:got:hello', 'sleep:0.1'];
        const run = await record(steps);
        expect(run.code).toBe(0);
        const summary = JSON.parse(run.stdout);
        expect(summary.stop).toBe('settled');
        expect(summary.frames).toBeGreaterThanOrEqual(2);
        expect(actions()).toEqual(['launch', ...steps]);
        expect(leftoverSockets()).toEqual([]);
        await providerHasExited();
        const { frame } = extractLast();
        expect(frame).toContain('=== test results ===');
        expect(frame).toContain('READY>');
        expect(frame).toContain('got:hello');
    });
    it('without steps, records until the settle time passes and leaves no tmux server', async () => {
        const run = await record([], ['--settle', '2', '--timeout', '10']);
        expect(run.code).toBe(0);
        const summary = JSON.parse(run.stdout);
        expect(summary.stop).toBe('settled');
        expect(summary.frames).toBeGreaterThanOrEqual(1);
        expect(actions()).toEqual(['launch']);
        expect(extractLast().frame).toContain('READY>');
        expect(leftoverSockets()).toEqual([]);
        await providerHasExited();
    });
    it('types text that starts with a hyphen as text', async () => {
        const run = await record(['wait:READY>', 'text:-n', 'keys:Enter', 'wait:got:-n']);
        expect(run.code).toBe(0);
        expect(JSON.parse(run.stdout).stop).toBe('settled');
        expect(extractLast().frame).toContain('got:-n');
    });
    it('saves the screen its last step produced even when the settle time is shorter than the interval', async () => {
        const run = await record(['wait:READY>', 'text:hello', 'keys:Enter'], ['--interval-ms', '500', '--settle', '0.05']);
        expect(run.code).toBe(0);
        expect(JSON.parse(run.stdout).stop).toBe('settled');
        expect(extractLast().frame).toContain('got:hello');
    });
    it('stops with pane_dead when the provider exits and names the step it never reached', async () => {
        const run = await record(['wait:READY>', 'text:quit', 'keys:Enter', 'wait:never-shown']);
        expect(run.code).toBe(0);
        expect(JSON.parse(run.stdout).stop).toBe('pane_dead');
        expect(run.stderr).toContain('stopped before step wait:never-shown');
        expect(readFileSync(join(out, 'frames.txt'), 'utf8')).toContain('READY>');
        expect(leftoverSockets()).toEqual([]);
    });
    it('stops with timeout when a wait step never matches', async () => {
        const run = await record(['wait:never-shown'], ['--timeout', '1']);
        expect(run.code).toBe(0);
        expect(JSON.parse(run.stdout).stop).toBe('timeout');
        expect(run.stderr).toContain('stopped before step wait:never-shown');
        expect(leftoverSockets()).toEqual([]);
        await providerHasExited();
    });
    function extractLast() {
        const corpus = join(root, 'corpus');
        const extracted = spawnSync(process.execPath, [RECORDER, 'extract', '--from', join(out, 'frames.txt'), '--state', 'idle', '--corpus', corpus], { encoding: 'utf8' });
        expect(extracted.status).toBe(0);
        const [entry] = JSON.parse(readFileSync(join(corpus, 'manifest.json'), 'utf8'));
        return { frame: readFileSync(join(corpus, extracted.stdout.trim()), 'utf8'), entry: entry };
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
        const summary = JSON.parse(run.stdout);
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
        const argv = JSON.parse(readFileSync(join(root, 'argv.json'), 'utf8'));
        expect(argv[argv.indexOf('--model') + 1]).toBe('stub-model-1');
        expect(extractLast().entry).toMatchObject({ provider: 'codex', launch_args: argv });
    });
    it('with only a provider and a binary, records a 120x40 pane into new temporary directories', async () => {
        const provider = join(root, 'provider.mjs');
        pidFile = join(root, 'provider.pid');
        writeFileSync(provider, PROVIDER_SOURCE);
        const tmp = join(root, 'tmp');
        mkdirSync(tmp);
        const run = await runRecorder(['record', '--provider', 'claude', '--bin', process.execPath, '--args', JSON.stringify([provider, pidFile])], undefined, { env: { TMPDIR: tmp } });
        expect(run.code).toBe(0);
        const summary = JSON.parse(run.stdout);
        expect(summary.stop).toBe('settled');
        expect(dirname(realpathSync(summary.out))).toBe(realpathSync(tmp));
        expect(basename(summary.out)).toMatch(/^pane-frames-claude-/);
        expect(dirname(summary.cwd)).toBe(realpathSync(tmp));
        expect(basename(summary.cwd)).toMatch(/^pane-frames-cwd-claude-/);
        out = summary.out;
        expect(JSON.parse(readFileSync(join(out, 'meta.json'), 'utf8'))).toMatchObject({ cols: 120, rows: 40, history: 0, hooks: false, cwd: summary.cwd });
        const { frame, entry } = extractLast();
        expect(frame).toContain('size:120x40');
        expect(entry).toMatchObject({ cols: 120, rows: 40 });
        expect(leftoverSockets()).toEqual([]);
        await providerHasExited();
    });
    it('files frames under version "unknown" when the binary reports no version', async () => {
        const stub = join(root, 'stub-claude.mjs');
        writeFileSync(stub, CONTRACT_STUB_SOURCE.replace("console.log('stub 9.8.7');", "console.error('no version here');"));
        chmodSync(stub, 0o755);
        out = join(root, 'out');
        const run = await runRecorder([
            'record', '--provider', 'claude', '--bin', stub, '--args', '["--flag"]', '--out', out, '--cwd', root,
            '--interval-ms', '20', '--settle', '0.3', '--timeout', '20', '--step', 'wait:READY>',
        ]);
        expect(run.code).toBe(0);
        expect(JSON.parse(run.stdout)).toMatchObject({ stop: 'settled', version: 'unknown' });
        expect(JSON.parse(readFileSync(join(out, 'meta.json'), 'utf8'))).toMatchObject({ version: 'unknown' });
        const { frame, entry } = extractLast();
        expect(frame).toContain('READY>');
        expect(entry).toMatchObject({ file: 'claude/unknown/idle.txt', version: 'unknown' });
        expect(leftoverSockets()).toEqual([]);
    });
    it('counts --timeout from the launch, not from a slow version probe', async () => {
        const stub = join(root, 'stub-claude.mjs');
        writeFileSync(stub, CONTRACT_STUB_SOURCE.replace("console.log('stub 9.8.7');", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3500); console.log('stub 9.8.7');"));
        chmodSync(stub, 0o755);
        out = join(root, 'out');
        const run = await runRecorder([
            'record', '--provider', 'claude', '--bin', stub, '--args', '["--flag"]', '--out', out, '--cwd', root,
            '--interval-ms', '20', '--settle', '0.3', '--timeout', '3', '--step', 'wait:READY>',
        ]);
        expect(run.code).toBe(0);
        expect(JSON.parse(run.stdout)).toMatchObject({ stop: 'settled', version: '9.8.7' });
        expect(extractLast().frame).toContain('READY>');
    });
    it('without --bin, launches the model contract binary found on PATH', async () => {
        const bin = join(root, 'bin');
        mkdirSync(bin);
        writeFileSync(join(bin, 'codex'), CONTRACT_STUB_SOURCE);
        chmodSync(join(bin, 'codex'), 0o755);
        // The stub has no extension, so Node takes its module type from the nearest package.json.
        // One beside it keeps a package.json above the test root, such as /tmp/package.json, out of it.
        writeFileSync(join(bin, 'package.json'), '{"type":"module"}');
        writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}');
        out = join(root, 'out');
        // PATH holds only the stub, node, tmux and the system directories, and /bin/sh reads
        // no startup file, so neither the recorder nor the pane can reach an installed codex.
        symlinkSync(process.execPath, join(bin, 'node'));
        symlinkSync(TMUX_PATH, join(bin, 'tmux'));
        const run = await runRecorder([
            'record', '--provider', 'codex', '--out', out, '--cwd', root,
            '--interval-ms', '20', '--settle', '0.3', '--timeout', '20', '--step', 'wait:READY>',
        ], undefined, { env: { PATH: [bin, '/usr/bin', '/bin'].join(delimiter), SHELL: '/bin/sh' } });
        expect(run.code).toBe(0);
        const summary = JSON.parse(run.stdout);
        expect(summary.version).toBe('9.8.7');
        expect(JSON.parse(readFileSync(join(bin, 'argv.json'), 'utf8'))).toEqual(summary.launch_args);
        expect(JSON.parse(readFileSync(join(out, 'meta.json'), 'utf8'))).toMatchObject({ binary: 'codex' });
        expect(extractLast().entry).toMatchObject({ provider: 'codex', version: '9.8.7', launch_args: summary.launch_args });
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
        ], undefined, { cwd: root });
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
        const settings = JSON.parse(readFileSync(join(out, 'hook-settings.json'), 'utf8'));
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
            spawnSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' });
        });
        expect(run.code).not.toBe(0);
        expect(run.stdout).toBe('');
        expect(leftoverSockets()).toEqual([]);
    });
    it.each(['SIGINT', 'SIGTERM', 'SIGHUP'])('kills its tmux server and the provider on %s', async (signal) => {
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
//# sourceMappingURL=record-pane-frames.test.js.map