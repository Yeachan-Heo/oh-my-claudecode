#!/usr/bin/env node
// Records what a team worker pane shows while a provider CLI starts, and files
// chosen frames into the pane-frame fixture corpus.
//
//   record   Launch a provider in a private tmux server, save every changed
//            `capture-pane -p -J` frame with a timestamp, run --step actions,
//            then kill the server.
//   extract  Copy one frame from a recording (or a plain text file) into
//            src/team/__tests__/fixtures/pane-frames/<provider>/<version>/<state>.txt
//            and upsert its manifest entry.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS_ROOT = join(REPO_ROOT, 'src', 'team', '__tests__', 'fixtures', 'pane-frames');
const MANIFEST_PATH = join(CORPUS_ROOT, 'manifest.json');
const SOURCES = ['recorded', 'migrated', 'synthetic'];
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop'];

const USAGE = `Usage:
  node scripts/record-pane-frames.mjs record --provider <claude|codex|cursor|gemini|grok|antigravity>
      [--args '<json array>'] [--model <id>] [--bin <path>] [--cwd <dir>] [--out <dir>]
      [--cols 120] [--rows 40] [--history 0] [--interval-ms 50] [--timeout 120] [--settle 3]
      [--hooks] [--step wait:<regex> | keys:<tmux keys> | text:<literal> | sleep:<seconds>]...
  node scripts/record-pane-frames.mjs extract --from <frames.txt|plain.txt> --state <label>
      [--frame <index|last>] [--provider <p>] [--version <v>] [--cols <n>] [--rows <n>]
      [--args '<json array>'] [--source recorded|migrated|synthetic] [--origin <text>] [--note <text>]

record defaults its launch args to model-contract.ts buildLaunchArgs(), so the
frames match a real worker. Those args include each provider's approval bypass
flag; pass --args to launch without it. A wait:<regex> step is tested against
the frame with every whitespace run collapsed to one space. --history 80 adds
the scrollback lines the team runtime's own capture (-S -80) includes.`;

function fail(message) {
  process.stderr.write(`record-pane-frames: ${message}\n\n${USAGE}\n`);
  process.exit(2);
}

function parseJsonArray(value, flag) {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) return parsed;
  } catch { /* reported below */ }
  return fail(`${flag} must be a JSON array of strings`);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function contractLaunchArgs(provider, model) {
  const { tsImport } = await import('tsx/esm/api');
  const contract = await tsImport(pathToFileURL(join(REPO_ROOT, 'src', 'team', 'model-contract.ts')).href, import.meta.url);
  return {
    binary: contract.getContract(provider).binary,
    args: contract.buildLaunchArgs(provider, { teamName: 'record', workerName: 'record', cwd: process.cwd(), ...(model ? { model } : {}) }),
  };
}

function providerVersion(bin) {
  const result = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 20_000 });
  const match = /\d+\.\d+\.\d+(?:[-.][0-9A-Za-z]+)*/.exec(`${result.stdout ?? ''} ${result.stderr ?? ''}`);
  return match ? match[0] : 'unknown';
}

function parseStep(raw) {
  const separator = raw.indexOf(':');
  const kind = separator < 0 ? raw : raw.slice(0, separator);
  const value = separator < 0 ? '' : raw.slice(separator + 1);
  if (kind === 'wait') return { kind, pattern: new RegExp(value, 'u') };
  if (kind === 'keys') return { kind, keys: value.split(/\s+/).filter(Boolean) };
  if (kind === 'text') return { kind, text: value };
  if (kind === 'sleep' && Number(value) >= 0) return { kind, ms: Number(value) * 1000 };
  return fail(`unknown --step ${raw}`);
}

function writeHookSettings(dir, eventsLog) {
  const hookScript = join(dir, 'hook.mjs');
  writeFileSync(hookScript, [
    "import { appendFileSync, readFileSync } from 'node:fs';",
    'const at = (Date.now() / 1000).toFixed(3);',
    "let input = {}; try { input = JSON.parse(readFileSync(0, 'utf8')); } catch {}",
    "const flags = input.stop_hook_active === true ? ' stop_hook_active' : '';",
    `appendFileSync(${JSON.stringify(eventsLog)}, \`\${at} \${input.hook_event_name ?? 'unknown'}\${flags}\\n\`);`,
  ].join('\n'));
  const command = `${shellQuote(process.execPath)} ${shellQuote(hookScript)}`;
  const settingsPath = join(dir, 'hook-settings.json');
  writeFileSync(settingsPath, JSON.stringify({
    hooks: Object.fromEntries(HOOK_EVENTS.map(event => [event, [{ hooks: [{ type: 'command', command }] }]])),
  }, null, 2));
  return settingsPath;
}

async function record(values) {
  const provider = values.provider ?? fail('--provider is required');
  const cols = Number(values.cols ?? 120);
  const rows = Number(values.rows ?? 40);
  const history = Number(values.history ?? 0);
  const intervalMs = Number(values['interval-ms'] ?? 50);
  const deadline = Date.now() + Number(values.timeout ?? 120) * 1000;
  const settleMs = Number(values.settle ?? 3) * 1000;
  const steps = (values.step ?? []).map(parseStep);

  const contract = await contractLaunchArgs(provider, values.model);
  const bin = values.bin ?? contract.binary;
  const launchArgs = values.args === undefined ? contract.args : parseJsonArray(values.args, '--args');
  const out = resolve(values.out ?? mkdtempSync(join(tmpdir(), `pane-frames-${provider}-`)));
  mkdirSync(out, { recursive: true });
  const cwd = realpathSync(values.cwd ?? mkdtempSync(join(tmpdir(), `pane-frames-cwd-${provider}-`)));
  const framesPath = join(out, 'frames.txt');
  const eventsLog = join(out, 'hook-events.log');
  const argv = [...launchArgs];
  if (values.hooks) {
    if (provider !== 'claude') fail('--hooks is only supported for claude');
    argv.push('--settings', writeHookSettings(out, eventsLog));
  }

  const version = providerVersion(bin);
  const meta = {
    provider,
    version,
    binary: bin,
    launch_args: launchArgs,
    hooks: Boolean(values.hooks),
    cols,
    rows,
    history,
    cwd,
    steps: values.step ?? [],
    started_at: new Date().toISOString(),
  };
  writeFileSync(join(out, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  writeFileSync(framesPath, '');

  const socket = `pane-frames-${process.pid}-${randomBytes(4).toString('hex')}`;
  const tmux = (...args) => execFileSync('tmux', ['-u', '-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8' });
  let socketPath = null;
  // kill-server leaves the socket file behind on macOS, so remove it too.
  const killServer = () => {
    spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
    if (socketPath) rmSync(socketPath, { force: true });
  };
  const onSignal = () => { killServer(); process.exit(130); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let frameCount = 0;
  let stopReason = 'error';
  let last = null;
  const capture = () => {
    const frame = tmux('capture-pane', '-p', '-J', '-t', 'rec:0.0', ...(history > 0 ? ['-S', `-${history}`] : []));
    if (frame !== last) {
      appendFileSync(framesPath, `=== ${(Date.now() / 1000).toFixed(3)}\n${frame}`);
      last = frame;
      frameCount += 1;
    }
    return frame;
  };
  const paneDead = () => tmux('display-message', '-p', '-t', 'rec:0.0', '#{pane_dead}').trim() === '1';

  try {
    // A placeholder command keeps the server alive until remain-on-exit is set,
    // so a provider that exits at once still leaves its last frame readable.
    tmux('new-session', '-d', '-s', 'rec', '-x', String(cols), '-y', String(rows), 'sleep 86400');
    socketPath = tmux('display-message', '-p', '#{socket_path}').trim();
    tmux('set-option', '-g', 'remain-on-exit', 'on');
    tmux('respawn-pane', '-k', '-t', 'rec:0.0', '-c', cwd, [bin, ...argv].map(shellQuote).join(' '));
    const launchedAt = Date.now();
    appendFileSync(join(out, 'actions.log'), `${(launchedAt / 1000).toFixed(3)} launch\n`);

    let stepIndex = 0;
    let stepStartedAt = Date.now();
    let settleUntil = steps.length === 0 ? Date.now() + settleMs : Infinity;
    stopReason = 'timeout';
    while (Date.now() < deadline) {
      if (Date.now() >= settleUntil) { stopReason = 'settled'; break; }
      const frame = capture();
      if (paneDead()) { capture(); stopReason = 'pane_dead'; break; }
      const step = steps[stepIndex];
      let done = false;
      if (step?.kind === 'wait') done = step.pattern.test(frame.replace(/\s+/g, ' '));
      else if (step?.kind === 'sleep') done = Date.now() - stepStartedAt >= step.ms;
      else if (step) {
        if (step.kind === 'keys') tmux('send-keys', '-t', 'rec:0.0', ...step.keys);
        else tmux('send-keys', '-t', 'rec:0.0', '-l', step.text);
        done = true;
      }
      if (done) {
        appendFileSync(join(out, 'actions.log'), `${(Date.now() / 1000).toFixed(3)} ${values.step[stepIndex]}\n`);
        stepIndex += 1;
        stepStartedAt = Date.now();
        if (stepIndex === steps.length) settleUntil = Date.now() + settleMs;
      }
      await sleep(intervalMs);
    }
    if (stepIndex < steps.length) process.stderr.write(`record-pane-frames: stopped before step ${values.step[stepIndex]}\n`);
  } finally {
    killServer();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  process.stdout.write(`${JSON.stringify({ out, frames: frameCount, stop: stopReason, provider, version, launch_args: launchArgs, cwd })}\n`);
}

function readFrames(path) {
  const raw = readFileSync(path, 'utf8');
  if (!raw.startsWith('=== ')) return [raw];
  return raw.split(/^=== [^\n]*\n/m).slice(1);
}

function readManifest() {
  return existsSync(MANIFEST_PATH) ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) : [];
}

function extract(values) {
  const from = resolve(values.from ?? fail('--from is required'));
  const state = values.state ?? fail('--state is required');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(state)) fail('--state must be kebab-case');
  const metaPath = join(dirname(from), 'meta.json');
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};
  const frames = readFrames(from);
  const index = values.frame === undefined || values.frame === 'last' ? frames.length - 1 : Number(values.frame);
  const frame = frames[index];
  if (frame === undefined) fail(`--frame ${values.frame} is out of range (0..${frames.length - 1})`);
  const source = values.source ?? 'recorded';
  if (!SOURCES.includes(source)) fail(`--source must be one of ${SOURCES.join(', ')}`);

  const provider = values.provider ?? meta.provider ?? fail('--provider is required without meta.json');
  const version = values.version ?? meta.version ?? fail('--version is required without meta.json');
  const file = `${provider}/${version}/${state}.txt`;
  const target = join(CORPUS_ROOT, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, frame);

  const entry = {
    file,
    provider,
    version,
    state,
    cols: values.cols === undefined ? (meta.cols ?? null) : Number(values.cols),
    rows: values.rows === undefined ? (meta.rows ?? null) : Number(values.rows),
    launch_args: values.args === undefined ? (meta.launch_args ?? null) : parseJsonArray(values.args, '--args'),
    source,
    origin: values.origin ?? `${relative(REPO_ROOT, from)}#${index}`,
    ...(values.note ? { note: values.note } : {}),
  };
  const manifest = readManifest().filter(existing => existing.file !== file);
  manifest.push(entry);
  manifest.sort((a, b) => a.file.localeCompare(b.file));
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${file}\n`);
}

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    provider: { type: 'string' },
    args: { type: 'string' },
    model: { type: 'string' },
    bin: { type: 'string' },
    cwd: { type: 'string' },
    out: { type: 'string' },
    cols: { type: 'string' },
    rows: { type: 'string' },
    history: { type: 'string' },
    'interval-ms': { type: 'string' },
    timeout: { type: 'string' },
    settle: { type: 'string' },
    hooks: { type: 'boolean' },
    step: { type: 'string', multiple: true },
    from: { type: 'string' },
    frame: { type: 'string' },
    state: { type: 'string' },
    version: { type: 'string' },
    source: { type: 'string' },
    origin: { type: 'string' },
    note: { type: 'string' },
  },
});

if (command === 'record') await record(values);
else if (command === 'extract') extract(values);
else fail(`unknown command ${command ?? '<none>'}`);
