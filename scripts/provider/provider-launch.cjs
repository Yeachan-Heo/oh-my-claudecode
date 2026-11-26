#!/usr/bin/env node
'use strict';
// Session launcher for a provider profile. It is used as the starter of a launcher that passes
// `--settings <file>` to `claude` (or run directly with the same arguments): it writes a copy of
// that settings file next to the original, adds the provider environment, the key helper, a PATH
// that starts with the shims (`claude` and the Bash guard hook), and starts the real `claude` with
// the copy. The shared Claude configuration stays; only the model provider changes.
//
// Without a key the start is aborted (exit 3) before `claude` is called: the launcher runs the key
// helper itself (the same validation as apiKeyHelper) and keeps the key in memory only. The key goes
// into the settings copy (0600) as ANTHROPIC_AUTH_TOKEN in the env block, so a child process that
// inherits the session environment (absolute-path `claude`, `sudo -E`, a script) sends the provider
// key to the provider address and never a stored subscription login. While a local proxy of the
// profile runs, the copy carries the proxy client token instead of the key. The process environment
// drops ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN and CLAUDE_CODE_OAUTH_TOKEN.
//
// Test-only variables: OMC_PROVIDER_API_KEY_FILE, OMC_PROVIDER_BASE_URL (loopback only, only together
// with the key file) and OMC_PROVIDER_CLAUDE_BIN.
//
// Exit codes: 2 bad configuration or usage, 3 no key or no slot, 4 quota gate refusal, 127 `claude`
// cannot be started, otherwise the exit code of `claude` (128 + signal number after a signal).
const { chmodSync, readFileSync, writeFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const SIGNAL_NUMBERS = require('node:os').constants.signals;
const { basename, dirname, join } = require('node:path');
const { ProfileError, loadProfile } = require('./lib/profile.cjs');
const { executorEnv } = require('./lib/env.cjs');
const { mask } = require('./lib/redact.cjs');
const settingsLib = require('./lib/settings.cjs');
const { acquireSlot, releaseSlot } = require('./lib/slots.cjs');
const { gate } = require('./lib/quota.cjs');
const { resolveEndpoint } = require('./lib/proxy-state.cjs');

const fail = (code, text) => { console.error(`provider-launch: ${mask(text)}`); process.exit(code); };
const argv = process.argv.slice(2);
const printMode = argv.includes('-p') || argv.includes('--print');
const at = argv.indexOf('--settings');
if (at < 0 || !argv[at + 1]) fail(2, 'no --settings in the launcher arguments; start aborted');

let loaded;
let endpoint;
try {
  loaded = loadProfile(process.env);
  endpoint = resolveEndpoint(loaded.profile, process.env);
} catch (e) {
  if (e instanceof ProfileError) fail(e.exit, `${e.message}; start aborted`);
  throw e;
}
const profile = loaded.profile;
const helperPath = join(__dirname, 'provider-key-helper.cjs');
const read = settingsLib.readKey(profile, process.env, helperPath);
if (read.error) fail(3, read.error);

(async () => {
  // Quota gate after the key check and before the settings file is read: a refusal ends the start (exit 4).
  const verdict = await gate(profile, process.env, read.key);
  if (verdict.refuse) { console.error(`provider-launch: ${verdict.message}`); process.exit(verdict.code); }
  // At a running proxy the session gets the client token; the real key stays with the proxy.
  const token = endpoint.viaProxy ? endpoint.clientToken : read.key;
  const source = argv[at + 1];
  let settings;
  try {
    settings = JSON.parse(readFileSync(source, 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('not an object');
  } catch (e) { fail(2, `the --settings file is not a JSON object (${e.message}); start aborted`); }
  // Fixed name: a repeated start of the launcher (without flags) overwrites the same copy.
  const copy = join(dirname(source), `${basename(source).replace(/\.json$/, '')}-provider.json`);
  try {
    settingsLib.addProvider(settings, {
      profile,
      baseUrl: endpoint.baseUrl,
      helperPath,
      env: process.env,
      file: copy,
      target: join(__dirname, 'provider-worker.cjs'),
      guardPath: join(__dirname, 'provider-bash-guard.cjs'),
      key: token,
      proxyPort: endpoint.viaProxy ? new URL(endpoint.baseUrl).port : undefined,
    });
  } catch (e) { fail(2, `cannot prepare the provider settings (${e.message}); start aborted`); }
  // Optional Jev switches of the profile (both off by default): in print mode compaction cannot run,
  // so OMC_JEV=off; otherwise an inherited OMC_JEV keeps everything except the compaction point.
  // The value reaches the session twice: in the child process environment (explicit) and in the env block of the copy.
  const printOff = printMode && profile.launch.disableJevInPrintMode;
  const fromProcess = process.env.OMC_JEV;
  const fromFile = typeof settings.env.OMC_JEV === 'string' ? settings.env.OMC_JEV : '';
  const inherited = fromProcess === undefined || fromProcess === '' ? fromFile : fromProcess;
  if (printOff) settings.env.OMC_JEV = 'off';
  else if (profile.launch.jevWithoutCompaction && inherited) settings.env.OMC_JEV = settingsLib.jevWithoutCompaction(inherited);
  settingsLib.sweepCopies(dirname(source));
  writeFileSync(copy, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(copy, 0o600);
  argv[at + 1] = copy;
  const starter = settingsLib.resolveClaudeBinary(profile, process.env, __filename);
  if (!starter) fail(127, 'no usable claude binary (set OMC_PROVIDER_CLAUDE_BIN or profile.claudeBinary)');
  // Session slot: a session started through this launcher counts toward the profile limit. Taken before the start,
  // released when the child ends, also on a start error. A bad limit value is a configuration error (2), no slot is exit 3.
  // For a background session the starter returns right after the start, so the slot is released after a few seconds:
  // the limit counts the moments of starting a background session, not their duration.
  let slot;
  try { slot = acquireSlot(profile, process.env); } catch (e) {
    if (e instanceof ProfileError) fail(e.exit, `${e.message}; start aborted`);
    throw e;
  }
  if (!slot.ok) fail(3, slot.reason);
  // spawn, not spawnSync: SIGTERM/SIGINT/SIGHUP sent to the launcher go to the child, and the launcher ends only after the child
  // (with its exit code or 128 + the signal number); the slot is released when the child ends. A launcher killed with SIGKILL
  // passes nothing on and leaves the child orphaned: the quota guard ends the tree at STOP.
  const release = () => { try { releaseSlot(slot.file); } catch { /* a failed release does not change the exit code */ } };
  let child;
  const startError = (e) => { release(); fail(127, `cannot start ${starter}: ${e.code || e.message}`); };
  try {
    child = spawn(starter, argv, {
      stdio: 'inherit',
      env: executorEnv(process.env, { explicit: printOff ? { OMC_JEV: 'off' } : undefined, session: true, profile }),
    });
  } catch (e) { startError(e); }
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, (name) => { try { child.kill(name); } catch { /* already ended */ } });
  child.on('error', startError);
  child.on('exit', (code, signal) => {
    release();
    process.exit(code ?? (signal ? 128 + (SIGNAL_NUMBERS[signal] ?? 0) : 0));
  });
})();
