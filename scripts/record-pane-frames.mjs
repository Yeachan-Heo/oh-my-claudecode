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
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { constants as osConstants, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS_ROOT = join(REPO_ROOT, 'src', 'team', '__tests__', 'fixtures', 'pane-frames');
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
      [--corpus <dir>]

record defaults its launch args to model-contract.ts buildLaunchArgs(), so the
frames match a real worker. Those args include each provider's approval bypass
flag; pass --args to launch without it. A wait:<regex> step is tested against
the frame with every whitespace run collapsed to one space. --history 80 adds
the scrollback lines the team runtime's own capture (-S -80) includes.
--corpus files the frame under another directory than the checked-in corpus.`;

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

function numberOption(values, name, fallback, { integer = false, min = 0 } = {}) {
  if (values[name] === undefined) return fallback;
  const number = values[name].trim() === '' ? NaN : Number(values[name]);
  if (!Number.isFinite(number) || number < min || (integer && !Number.isInteger(number))) {
    fail(`--${name} must be ${integer ? 'an integer' : 'a number'} of at least ${min}`);
  }
  return number;
}

// provider and version become directories under the corpus, so neither may name a path.
function pathComponent(value, flag) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value)) {
    fail(`${flag} must be a single name of letters, digits, ".", "_", "+" and "-"`);
  }
  return value;
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
  if (kind === 'sleep' && value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0) return { kind, ms: Number(value) * 1000 };
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
  const cols = numberOption(values, 'cols', 120, { integer: true, min: 1 });
  const rows = numberOption(values, 'rows', 40, { integer: true, min: 1 });
  const history = numberOption(values, 'history', 0, { integer: true });
  const intervalMs = numberOption(values, 'interval-ms', 50, { min: 1 });
  const timeoutMs = numberOption(values, 'timeout', 120) * 1000;
  const settleMs = numberOption(values, 'settle', 3) * 1000;
  const steps = (values.step ?? []).map(parseStep);
  // tmux starts the pane in the home directory when -c is not a directory.
  if (values.cwd !== undefined && !(existsSync(values.cwd) && statSync(values.cwd).isDirectory())) {
    fail(`--cwd ${values.cwd} is not a directory`);
  }

  const contract = await contractLaunchArgs(provider, values.model);
  // The pane starts in --cwd, so a relative path is pinned to where the recorder
  // was started. A bare command name is left for PATH.
  const bin = values.bin === undefined ? contract.binary
    : /[\\/]/.test(values.bin) ? resolve(values.bin) : values.bin;
  const launchArgs = values.args === undefined ? contract.args : parseJsonArray(values.args, '--args');
  const out = resolve(values.out ?? mkdtempSync(join(tmpdir(), `pane-frames-${provider}-`)));
  mkdirSync(out, { recursive: true });
  const cwd = realpathSync(values.cwd ?? mkdtempSync(join(tmpdir(), `pane-frames-cwd-${provider}-`)));
  const framesPath = join(out, 'frames.txt');
  const actionsLog = join(out, 'actions.log');
  const eventsLog = join(out, 'hook-events.log');
  const argv = [...launchArgs];
  if (values.hooks) {
    if (provider !== 'claude') fail('--hooks is only supported for claude');
    if (argv.includes('--bare')) fail('--hooks cannot record under --bare: Claude skips hooks in bare mode (unset ANTHROPIC_API_KEY or pass --args)');
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
  // A reused --out must not keep the previous run's frames, actions or hook events.
  writeFileSync(framesPath, '');
  writeFileSync(actionsLog, '');
  rmSync(eventsLog, { force: true });

  const socket = `pane-frames-${process.pid}-${randomBytes(4).toString('hex')}`;
  const tmux = (...args) => execFileSync('tmux', ['-u', '-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8' });
  let socketPath = null;
  // kill-server leaves the socket file behind on macOS, so remove it too.
  const killServer = () => {
    spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
    if (socketPath) rmSync(socketPath, { force: true });
  };
  const onSignal = (signal) => { killServer(); process.exit(128 + osConstants.signals[signal]); };
  const cleanupSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of cleanupSignals) process.on(signal, onSignal);

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
    // Counted from the launch, so a slow version probe cannot use up the recording window.
    const deadline = launchedAt + timeoutMs;
    appendFileSync(actionsLog, `${(launchedAt / 1000).toFixed(3)} launch\n`);

    let stepIndex = 0;
    let stepStartedAt = Date.now();
    let settleUntil = steps.length === 0 ? Date.now() + settleMs : Infinity;
    stopReason = 'timeout';
    while (Date.now() < deadline) {
      // The interval can outlast the settle time, so the last step's screen is captured here.
      if (Date.now() >= settleUntil) { capture(); stopReason = 'settled'; break; }
      const frame = capture();
      if (paneDead()) { capture(); stopReason = 'pane_dead'; break; }
      const step = steps[stepIndex];
      let done = false;
      if (step?.kind === 'wait') done = step.pattern.test(frame.replace(/\s+/g, ' '));
      else if (step?.kind === 'sleep') done = Date.now() - stepStartedAt >= step.ms;
      else if (step) {
        if (step.kind === 'keys') tmux('send-keys', '-t', 'rec:0.0', ...step.keys);
        else tmux('send-keys', '-t', 'rec:0.0', '-l', '--', step.text);
        done = true;
      }
      if (done) {
        appendFileSync(actionsLog, `${(Date.now() / 1000).toFixed(3)} ${values.step[stepIndex]}\n`);
        stepIndex += 1;
        stepStartedAt = Date.now();
        if (stepIndex === steps.length) settleUntil = Date.now() + settleMs;
      }
      await sleep(intervalMs);
    }
    if (stepIndex < steps.length) process.stderr.write(`record-pane-frames: stopped before step ${values.step[stepIndex]}\n`);
  } finally {
    killServer();
    for (const signal of cleanupSignals) process.off(signal, onSignal);
  }

  process.stdout.write(`${JSON.stringify({ out, frames: frameCount, stop: stopReason, provider, version, launch_args: launchArgs, cwd })}\n`);
}

// Only the header capture() writes counts, so a pane line such as
// "=== test results ===" stays inside its frame.
const FRAME_HEADER = /^=== \d+\.\d{3}\n/m;

function readFrames(path) {
  const raw = readFileSync(path, 'utf8');
  if (raw.search(FRAME_HEADER) !== 0) return [raw];
  return raw.split(FRAME_HEADER).slice(1);
}


function extract(values) {
  const from = resolve(values.from ?? fail('--from is required'));
  const state = values.state ?? fail('--state is required');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(state)) fail('--state must be kebab-case');
  const metaPath = join(dirname(from), 'meta.json');
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};
  const frames = readFrames(from);
  const index = values.frame === undefined || values.frame === 'last'
    ? frames.length - 1
    : numberOption(values, 'frame', 0, { integer: true });
  const frame = frames[index];
  if (frame === undefined) fail(`--frame ${values.frame} is out of range (0..${frames.length - 1})`);
  const source = values.source ?? 'recorded';
  if (!SOURCES.includes(source)) fail(`--source must be one of ${SOURCES.join(', ')}`);

  const provider = pathComponent(values.provider ?? meta.provider ?? fail('--provider is required without meta.json'), '--provider');
  const version = pathComponent(values.version ?? meta.version ?? fail('--version is required without meta.json'), '--version');
  const file = `${provider}/${version}/${state}.txt`;
  const corpusRoot = values.corpus === undefined ? CORPUS_ROOT : resolve(values.corpus);
  const manifestPath = join(corpusRoot, 'manifest.json');
  const target = join(corpusRoot, file);

  const entry = {
    file,
    provider,
    version,
    state,
    cols: numberOption(values, 'cols', meta.cols ?? null, { integer: true, min: 1 }),
    rows: numberOption(values, 'rows', meta.rows ?? null, { integer: true, min: 1 }),
    launch_args: values.args === undefined ? (meta.launch_args ?? null) : parseJsonArray(values.args, '--args'),
    // --hooks adds --settings to the launch but not to launch_args.
    ...(meta.hooks ? { hooks: true } : {}),
    source,
    origin: values.origin ?? `${relative(REPO_ROOT, from)}#${index}`,
    ...(values.note ? { note: values.note } : {}),
  };
  const manifest = (existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : [])
    .filter(existing => existing.file !== file);
  // Both writes come after every check, so a refused extract leaves the corpus as it was.
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, frame);
  manifest.push(entry);
  manifest.sort((a, b) => a.file.localeCompare(b.file));
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
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
    corpus: { type: 'string' },
  },
});

if (command === 'record') await record(values);
else if (command === 'extract') extract(values);
else fail(`unknown command ${command ?? '<none>'}`);
