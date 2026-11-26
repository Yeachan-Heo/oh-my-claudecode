#!/usr/bin/env node
'use strict';
// Wrapper for the `claude` binary: workers of `omc team` (tmux) and nested `claude` calls inside
// provider processes. The lead runs on Claude, workers of the profile roles run on the provider,
// every other role runs on Claude. Start a team with `provider-team`: PATH then starts with a
// directory whose `claude` shim runs this wrapper (OMC picks the binary with `which claude` and
// starts it by absolute path).
//
// Three modes, chosen from the process environment:
//  1. OMC_PROVIDER_SETTINGS_FILE is set (a child process of a provider session, env from --settings): `claude` by name
//     gets the --settings of that session at the end of its arguments (apiKeyHelper, hooks; the last --settings wins).
//  2. OMC_TEAM_WORKER is set (a worker started by omc team): a role listed in the profile runs on the provider: --settings
//     with the provider env and the key helper, the key as ANTHROPIC_AUTH_TOKEN in the process env (not in the file), so a
//     child that inherits the env (absolute-path `claude`, sudo -E) sends the provider key to the provider address and never
//     a subscription token. The model and effort come from the profile (worker.model, worker.effort). Without a key the start
//     is aborted with exit 3. Claude roles: provider variables are removed from the env. Without OMC_TEAM_ROLE the role comes from
//     the persistent team state (config.json, then manifest.json); exit 5 when no source names the role.
//  3. otherwise: the real `claude` with the arguments unchanged; with a foreign ANTHROPIC_BASE_URL in the env and no provider
//     settings the call is refused (exit 3), because without provider credentials a subscription token would go to that address.
//
// Real binary: OMC_PROVIDER_CLAUDE_BIN, then profile.claudeBinary, then the first `claude` on PATH outside the shim directories.
// Exit codes: 1 integrity failure, 2 bad configuration, 3 no key, no slot or refused, 4 quota gate refusal, 5 role unknown,
// 127 no binary or not startable, otherwise the exit code of `claude` (128 + signal number after a signal).
const { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { homedir } = require('node:os');
const SIGNAL_NUMBERS = require('node:os').constants.signals;
const { dirname, join } = require('node:path');
const { ProfileError, loadProfile, stateDirOf, statePath } = require('./lib/profile.cjs');
const { advisorControls, executorEnv, isForeignProvider, stripProviderEnv } = require('./lib/env.cjs');
const { mask } = require('./lib/redact.cjs');
const settingsLib = require('./lib/settings.cjs');
const { acquireSlot, releaseSlot } = require('./lib/slots.cjs');
const { gate } = require('./lib/quota.cjs');
const { resolveEndpoint } = require('./lib/proxy-state.cjs');
const { failureClass } = require('./lib/failure-class.cjs');
const { baselineFile, compareDigest, gitDigest, markBaselineChecked, sweepBaselines, writeBaseline } = require('./lib/git-integrity.cjs');
const { addNeed } = require('./lib/hook-need.cjs');
const { addRescue } = require('./lib/hook-rescue.cjs');
const { FAILURE_CLASSES, TASK_TEAM_RE, WORKER_EVENT_RESULTS: RESULT } = require('./lib/vocab.cjs');

const POINT = 'team-worker';
const fail = (code, text) => { console.error(`provider-worker: ${mask(text)}`); process.exit(code); };
const argv = process.argv.slice(2);
const self = realpathSync(process.argv[1]);
const env = process.env;

// Modes 1 and 3 do not spawn at once (spawn does not block like spawnSync, so the mode 2 code would run too): they set
// `direct` = { args, env }, and the spawn with its handlers runs at the end of the file when neither mode 1 nor mode 2 applies.
// Signals sent to the wrapper (SIGTERM/SIGINT/SIGHUP) go to the current `claude` child, and the wrapper ends only after it
// (with its exit code or 128 + the signal number). A wrapper killed with SIGKILL passes nothing on and leaves the child orphaned:
// the quota guard ends the tree at STOP.
let direct = null;
let currentChild = null;
// A signal that reaches the wrapper (forwarded to the child, or during an `await` before the spawn when there is no child yet)
// ends the wrapper: no new start attempt, exit code 128 + that signal number.
let interrupted = null;
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, (name) => { interrupted = name; try { if (currentChild) currentChild.kill(name); } catch { /* already ended */ } });
const signalCode = (signal) => 128 + (SIGNAL_NUMBERS[signal] ?? 0);

// The profile when there is one; `null` when no profile is configured at all (the wrapper then passes calls through unchanged).
const tryProfile = () => {
  try { return loadProfile(env); } catch (e) {
    if (e instanceof ProfileError && e.code === 'missing_profile') return null;
    if (e instanceof ProfileError) fail(e.exit, e.message);
    throw e;
  }
};
const noProfile = { claudeBinary: null, shimNames: [], stateDir: null, name: 'none' };
const realBinary = (profile) => {
  const found = settingsLib.resolveClaudeBinary(profile || noProfile, env, self);
  if (!found) fail(127, 'no usable claude binary (set OMC_PROVIDER_CLAUDE_BIN or profile.claudeBinary)');
  return found;
};
const startDirect = () => {
  if (interrupted) process.exit(signalCode(interrupted));
  const child = spawn(direct.binary, direct.args, { stdio: 'inherit', env: direct.env });
  currentChild = child;
  child.on('error', (e) => fail(127, `cannot start claude: ${e.code || e.message}`));
  child.on('exit', (code, signal) => process.exit(interrupted ? signalCode(interrupted) : code ?? (signal ? signalCode(signal) : 0)));
};
// --settings goes at the end (before `--` when present): the last value of a repeated option wins, so our settings win over the caller's.
const withSettings = (args, file) => { const k = args.indexOf('--'); return k < 0 ? [...args, '--settings', file] : [...args.slice(0, k), '--settings', file, ...args.slice(k)]; };
const withFlag = (args, name, value) => { const k = args.indexOf('--'); return k < 0 ? [...args, name, value] : [...args.slice(0, k), name, value, ...args.slice(k)]; };

// Mode 1: a nested claude inside a provider process (env of the session inherited, including ANTHROPIC_AUTH_TOKEN with the provider key).
if (env.OMC_PROVIDER_SETTINGS_FILE) {
  const file = env.OMC_PROVIDER_SETTINGS_FILE;
  if (!existsSync(file)) fail(3, 'the settings file of the provider session is missing; the nested claude does not start (a subscription token must not go to the provider address)');
  direct = { binary: realBinary(tryProfile()?.profile), args: withSettings(argv, file), env };
}
// Mode 3: not a worker.
if (!direct && !env.OMC_TEAM_WORKER) {
  if (isForeignProvider(env) || env.OMC_PROVIDER) fail(3, 'a foreign ANTHROPIC_BASE_URL in the env without provider session settings; claude does not start (a subscription token must not go to the provider address)');
  direct = { binary: realBinary(tryProfile()?.profile), args: argv, env };
}

// Mode 2: a worker of omc team.
(async () => {
  if (direct) { startDirect(); return; }
  // An invalid value of a worker setting in the environment makes the profile loader throw. These variables matter only for a provider role
  // (a Claude role never reads them), so the profile is loaded again without them; a provider role is aborted later with an event row:
  // for the model and effort before the key is read, for the session limit at the slot step. An invalid tool-call limit counts as 0 (no limit).
  const TOLERATED = new Set(['OMC_PROVIDER_WORKER_MODEL', 'OMC_PROVIDER_WORKER_EFFORT', 'OMC_PROVIDER_MAX_SESSIONS', 'OMC_PROVIDER_SLOT_WAIT_MS', 'OMC_PROVIDER_MAX_TOOL_CALLS']);
  // The invalid variables are removed from the process environment, so the key helper, the quota read and the child see the same profile as this process.
  const badEnv = new Set();
  let loadedProfile;
  for (;;) {
    try { loadedProfile = loadProfile(env); break; } catch (e) {
      if (!(e instanceof ProfileError)) throw e;
      if (e.code === 'missing_profile') {
        // Plain Claude only for an installation that is not configured at all: no profiles file and no profile named in OMC_PROVIDER_PROFILE.
        // Every other missing_profile is a selection error (a profile named by OMC_PROVIDER_PROFILE or defaultProfile that is not defined, or
        // several profiles and no choice): launching Claude would bypass the credential, quota and session checks of the provider that was chosen.
        if (!e.unconfigured || String(env.OMC_PROVIDER_PROFILE || '').trim()) fail(e.exit, e.message);
        loadedProfile = null;
        break;
      }
      const name = e.code === 'bad_field' ? (/\b(OMC_PROVIDER_[A-Z_]+)\b/.exec(e.message) || [])[1] : null;
      if (!name || !TOLERATED.has(name) || !(name in env)) fail(e.exit, e.message);
      badEnv.add(name);
      delete env[name];
    }
  }
  if (!loadedProfile) { // no profile at all: nothing to switch, the worker runs as plain Claude
    if (isForeignProvider(env)) fail(3, 'a foreign ANTHROPIC_BASE_URL in the env and no provider profile; claude does not start (a subscription token must not go to the provider address)');
    direct = { binary: realBinary(null), args: argv, env };
    startDirect();
    return;
  }
  const { profile } = loadedProfile;
  const binary = realBinary(profile);
  const home = env.HOME || homedir();
  const configDir = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  let role = env.OMC_TEAM_ROLE || '';
  let roleSource = role ? 'env' : null; // env, config or manifest: the field role_source of the event row
  const [team, name] = String(env.OMC_TEAM_WORKER).split('/');
  const stateDir = stateDirOf(profile, env);
  const record = (row) => { try { mkdirSync(stateDir, { recursive: true, mode: 0o700 }); appendFileSync(join(stateDir, 'workers.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), point: POINT, ...row })}\n`, { encoding: 'utf8', mode: 0o600 }); } catch { /* a missing log does not stop the start */ } };
  // Recovery of OMC builds the worker env without the role, so a recovered provider worker would silently start as Claude.
  // The role comes from the persistent team state: <OMC_TEAM_STATE_ROOT>/config.json, and without a role there manifest.json
  // (the workers[] entry whose name equals the worker name, field role). Exit 5 when OMC_TEAM_WORKER and OMC_TEAM_STATE_ROOT are set
  // but no source names the role and no file has an entry for the worker: OMC writes config.json with the worker entry before it starts
  // the pane, so a missing entry means a real missing role, not a false alarm.
  if (!role && env.OMC_TEAM_STATE_ROOT) {
    const entryFrom = (file) => {
      try {
        const data = JSON.parse(readFileSync(file, 'utf8'));
        const entries = Array.isArray(data && data.workers) ? data.workers : [];
        return { readable: true, entry: entries.find((w) => w && typeof w === 'object' && w.name === name) || null };
      } catch { return { readable: false, entry: null }; }
    };
    const roleOf = (entry) => (entry && typeof entry.role === 'string' && entry.role ? entry.role : null);
    const config = entryFrom(join(env.OMC_TEAM_STATE_ROOT, 'config.json'));
    const manifest = roleOf(config.entry) ? null : entryFrom(join(env.OMC_TEAM_STATE_ROOT, 'manifest.json'));
    const fromConfig = roleOf(config.entry);
    const fromManifest = manifest ? roleOf(manifest.entry) : null;
    if (fromConfig) { role = fromConfig; roleSource = 'config'; } else if (fromManifest) { role = fromManifest; roleSource = 'manifest'; } else if (!config.entry && !(manifest && manifest.entry)) {
      record({ role: null, name: env.OMC_TEAM_WORKER, team, provider: null, session_id: null, role_source: null, result: RESULT.ABORTED_NO_ROLE });
      fail(5, 'worker role unknown: no OMC_TEAM_ROLE and no entry in the team state');
    }
  }
  const onProvider = profile.roles.includes(role);
  const maxToolCalls = profile.worker.maxToolCalls;
  const provider = onProvider ? profile.name : 'claude';
  const helperPath = join(__dirname, 'provider-key-helper.cjs');
  const advisorFile = join(dirname(self), 'provider-advisor.cjs');
  const advisorPresent = existsSync(advisorFile);
  // The worker shims live in their own directory so the advisor shim does not reach provider sessions started by the launcher.
  const shimEnv = { ...env, OMC_PROVIDER_SHIM_DIR: env.OMC_PROVIDER_SHIM_DIR || settingsLib.shimDir(profile, env, 'worker') };
  const ruleFile = profile.worker.ruleFile || join(__dirname, '..', '..', 'templates', 'provider', 'worker-rule.md');
  const rule = (() => { try { return readFileSync(ruleFile, 'utf8').trim(); } catch { return ''; } })();

  // A provider role has a fixed model and effort (profile.worker.*); a value outside the allowed shape aborts the start before the key is read, with an event row.
  const fixedOk = (v) => /^[A-Za-z0-9][A-Za-z0-9._\-[\]]*$/.test(v.model) && ['low', 'medium', 'high', 'xhigh', 'max'].includes(v.effort);
  if (onProvider && (badEnv.has('OMC_PROVIDER_WORKER_MODEL') || badEnv.has('OMC_PROVIDER_WORKER_EFFORT') || !fixedOk({ model: profile.worker.model, effort: profile.worker.effort }))) {
    record({ role: `worker-${role}`, name: env.OMC_TEAM_WORKER, provider, result: RESULT.ABORTED_BAD_CONFIG, session_id: null });
    fail(2, 'the worker model or effort of the profile has a value that is not allowed; worker start aborted');
  }
  let endpoint; let token;
  if (onProvider) {
    try { endpoint = resolveEndpoint(profile, env); } catch (e) { if (e instanceof ProfileError) fail(e.exit, `${e.message}; worker start aborted`); throw e; }
    const read = settingsLib.readKey(profile, env, helperPath);
    if (read.error) { record({ role: `worker-${role}`, name: env.OMC_TEAM_WORKER, provider, result: RESULT.ABORTED_NO_KEY, session_id: null }); fail(3, read.error); }
    // Quota gate before the start of a provider worker: refusal with exit 4, no fallback to Claude, an event row as for a missing key.
    // The gate always uses the real key from the helper, also at a running proxy: the quota endpoint is called directly, the proxy serves only the worker session.
    const verdict = await gate(profile, env, read.key);
    if (verdict.refuse) { record({ role: `worker-${role}`, name: env.OMC_TEAM_WORKER, provider, result: RESULT.ABORTED_QUOTA, session_id: null }); fail(4, verdict.message); }
    token = endpoint.viaProxy ? endpoint.clientToken : read.key; // at a running proxy the client token (the real key stays with the proxy); otherwise the key
  }
  const resume = argv.some((a) => ['--resume', '-r', '--continue', '-c', '--session-id'].includes(a));
  const sessionId = resume ? null : randomUUID();

  const strip = (args, flag) => { const k = args.indexOf(flag); if (k >= 0) args.splice(k, 2); return args; };
  // Provider role: argv without --dangerously-skip-permissions (OMC adds it), with an explicit tool list, dontAsk mode and the git rule in
  // --append-system-prompt; --disallowedTools AskUserQuestion goes before `--` (defence in depth next to the AskUserQuestion hook: a provider worker never asks a human).
  const base = onProvider ? withFlag(settingsLib.workerArgs([...argv], profile), '--disallowedTools', 'AskUserQuestion') : [...argv];
  if (sessionId) base.push('--session-id', sessionId);
  // No MCP for a provider worker (profile.worker.mcp = none): --strict-mcp-config with an empty --mcp-config, before `--` and only without an own --mcp-config of the caller.
  const beforeDashes = (() => { const k = base.indexOf('--'); return k < 0 ? base : base.slice(0, k); })();
  const noMcp = !onProvider || profile.worker.mcp !== 'none' || beforeDashes.includes('--mcp-config') || beforeDashes.some((a) => a.startsWith('--mcp-config=')) ? [] : ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
  base.unshift(...noMcp);
  if (onProvider) {
    const dir = statePath(profile, env, 'worker-settings');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    settingsLib.sweepCopies(dir);
    const file = join(dir, `worker-${String(env.OMC_TEAM_WORKER).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
    // No key in the file: it goes only into the process env (ANTHROPIC_AUTH_TOKEN), so no apiKeyHelper either.
    const settings = settingsLib.addProvider({}, {
      profile,
      baseUrl: endpoint.baseUrl,
      helperPath,
      env: shimEnv,
      file,
      target: self,
      guardPath: join(__dirname, 'provider-bash-guard.cjs'),
      keyInProcessEnv: true,
      executor: true,
      extraShims: advisorPresent ? { [profile.advisor.commandName]: advisorFile } : {},
      proxyPort: endpoint.viaProxy ? new URL(endpoint.baseUrl).port : undefined,
    });
    // Subagents of a provider worker run on the subagent model of the profile, and without Jev unless the profile keeps it on.
    const aliasId = (alias) => (profile.models[alias] && profile.models[alias].id) || null;
    const subagent = profile.subagentModel ? (aliasId(profile.subagentModel) || profile.subagentModel) : aliasId(profile.models.haiku ? 'haiku' : profile.models.default);
    Object.assign(settings.env, { ...(subagent ? { CLAUDE_CODE_SUBAGENT_MODEL: subagent } : {}), ...(profile.worker.disableJev ? { OMC_JEV: 'off' } : {}), OMC_PROVIDER_ADVISOR_COMMAND: profile.advisor.commandName });
    // The advisor controls of the lead (switches, protocol, limits, caps) pass the executor env filter only through the settings env block.
    Object.assign(settings.env, advisorControls(env, (variable) => console.error(`provider-worker: ${variable} is not passed to the advisor (an invalid value, a relative path, or the final protocol, which stays with the lead)`)));
    // The advisor and the rescue hook in the session load the profile like the wrapper does, so they find the profiles file the wrapper used (a path, no secret).
    if (typeof profile.file === 'string' && profile.file) settings.env.OMC_PROVIDER_PROFILES_FILE = profile.file;
    // Hook for AskUserQuestion (always a denial with NEED:; the tool-call counter when a limit is set or the team is a task team) and the limit in the settings env block.
    addNeed(settings, { script: join(__dirname, 'provider-hook-need.cjs'), counter: maxToolCalls > 0 || TASK_TEAM_RE.test(team) });
    if (maxToolCalls > 0) Object.assign(settings.env, { OMC_PROVIDER_MAX_TOOL_CALLS: String(maxToolCalls) });
    // Rescue hooks (no registration when off); the task id from the team name and the parameters go to the settings env block. The profile values apply unless the environment sets them.
    const rescueEnv = { ...env };
    for (const [variable, value] of [['OMC_PROVIDER_RESCUE', profile.rescue.mode], ['OMC_PROVIDER_RESCUE_THRESHOLD', String(profile.rescue.threshold)], ['OMC_PROVIDER_RESCUE_ADVISOR_LIMIT', String(profile.rescue.advisorLimit)]]) {
      if (!rescueEnv[variable]) rescueEnv[variable] = value;
    }
    addRescue(settings, { env: rescueEnv, team, script: join(__dirname, 'provider-hook-rescue.cjs'), profile });
    writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    chmodSync(file, 0o600);
    base.push('--settings', file);
    // The worker rule is appended to the existing --append-system-prompt (one flag: claude may not accumulate repeated flags and would drop the git rule), or becomes its own.
    if (rule && advisorPresent) { const k = base.indexOf('--append-system-prompt'); if (k >= 0) base[k + 1] += `\n${rule}`; else base.push('--append-system-prompt', rule); }
  }
  const finalArgs = [...base];
  if (onProvider) {
    strip(finalArgs, '--model'); finalArgs.push('--model', profile.worker.model);
    strip(finalArgs, '--effort'); finalArgs.push('--effort', profile.worker.effort);
  }
  // The variable of an `env` key source (apiKey.env) reaches every pane, because provider-team forwards it so that a provider role can read the key; the
  // roles that stay on Claude must not keep it (the key stays away from them). A provider role gets the key only as ANTHROPIC_AUTH_TOKEN, from the allow-list env.
  const keyVariable = profile.apiKey && profile.apiKey.env;
  const withoutKeyVariable = (e) => {
    if (!keyVariable || !(keyVariable in e)) return e;
    const copy = { ...e };
    delete copy[keyVariable];
    return copy;
  };
  const childEnv = onProvider ? executorEnv(env, { explicit: { ANTHROPIC_AUTH_TOKEN: token }, profile }) : withoutKeyVariable(isForeignProvider(env) ? stripProviderEnv(env) : env);
  const baseRow = { role: `worker-${role}`, name: env.OMC_TEAM_WORKER, team, provider, session_id: sessionId, role_source: roleSource };
  record({ ...baseRow, started_with: { model: onProvider ? profile.worker.model : null, effort: onProvider ? profile.worker.effort : null }, ...(!onProvider && childEnv !== env ? { provider_env_stripped: true } : {}) });
  // Working directory of the worker: OMC_TEAM_WORKER_CWD (set for teams with a worktree), otherwise the process cwd (a team without worktrees).
  const gitCwd = env.OMC_TEAM_WORKER_CWD || process.cwd();
  // Session slots of provider workers: taken before `claude` starts (a start over the limit waits up to slotWaitMs or refuses), released after `claude` ends,
  // also on a start error. A bad limit value is a configuration error (exit 2), no slot is exit 3.
  let slot = null;
  if (onProvider) {
    if (badEnv.has('OMC_PROVIDER_MAX_SESSIONS') || badEnv.has('OMC_PROVIDER_SLOT_WAIT_MS')) {
      record({ ...baseRow, result: RESULT.ABORTED_BAD_CONFIG, reason: 'the session limit or the slot wait has a value that is not valid' });
      fail(2, 'the session limit or the slot wait has a value that is not valid; worker start aborted');
    }
    try { slot = acquireSlot(profile, env); } catch (e) {
      if (!(e instanceof ProfileError)) throw e;
      record({ ...baseRow, result: RESULT.ABORTED_BAD_CONFIG, reason: e.message });
      fail(2, `${e.message}; worker start aborted`);
    }
    if (!slot.ok) { record({ ...baseRow, result: RESULT.ABORTED_NO_SLOT }); fail(3, slot.reason); }
    if (slot.waitedMs >= 1000) record({ ...baseRow, slot_wait_ms: slot.waitedMs }); // a real wait (under 1 s is clock noise), a row for measurement
  }
  // Digest of the shared part of .git is taken AFTER the slot: the observation window covers the work of the worker, not the wait for a slot
  // (up to the slot wait limit), so compatible .git changes by other sessions during the wait do not end the task as an integrity failure.
  const digestBefore = gitDigest(gitCwd);
  // The baseline goes to disk for `provider-task result`: the worker posts its result before claude exits, so the reader cannot wait for the check below.
  const baseline = digestBefore && onProvider ? baselineFile(stateDir, team, name) : null;
  if (baseline) { sweepBaselines(stateDir); writeBaseline(baseline, gitCwd, digestBefore); }
  // A signal during an `await` before the spawn (the quota gate above) is not lost: checked here (before the spawn, after taking the slot), the slot is released and the exit code is 128 + signal.
  if (interrupted) {
    if (slot) releaseSlot(slot.file);
    fail(signalCode(interrupted), `interrupted by ${interrupted} before claude started`);
  }
  // The child claude is run with spawn and awaited (result in the shape of spawnSync: { status, signal, error }); signals of the wrapper go to it.
  const runChild = (args, childEnvironment) => new Promise((done) => {
    const child = spawn(binary, args, { stdio: 'inherit', env: childEnvironment });
    currentChild = child;
    child.on('error', (e) => done({ error: e }));
    child.on('exit', (code, signal) => done({ status: code, signal }));
  });
  let result;
  try {
    result = await runChild(finalArgs, childEnv);
    // No retry: a child ended by a signal (status === null, result.signal) or a signal to the wrapper (`interrupted`) starts no new claude, exit 128 + signal number (below),
    // and the model and effort of a provider role are fixed, so an error must be visible.
  } finally {
    if (slot) releaseSlot(slot.file);
  }
  // After the child ends the signal handlers are removed (default action): classifying a failure (the quota read up to 15 s, the transcript, the .git digest) no longer swallows SIGTERM/SIGINT/SIGHUP.
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.removeAllListeners(signal);
  // Failure class of a provider worker after `claude` ends: a final row with the field `class` (next to the `result` of the start row). Observations: the error field of the session transcript
  // (the last line with an API error: prefix "API Error:", provider codes, authentication_failed, billing_error) and a quota read after the failure (`provider-quota --json`; an element of the breaker).
  // The output of the commands of the worker is not read (stdio inherit), so it cannot change the class (the text "429" of a test run by the worker gives no throttle). No transcript or no quota read: classification without them.
  if (onProvider && !result.error && (result.status ?? (result.signal ? 1 : 0)) !== 0) {
    const exitCode = result.status ?? (result.signal ? 1 : 0);
    let text = null;
    try {
      for (const project of readdirSync(join(configDir, 'projects'))) {
        const transcript = join(configDir, 'projects', project, `${sessionId}.jsonl`);
        if (!existsSync(transcript)) continue;
        const lines = readFileSync(transcript, 'utf8').trim().split('\n').slice(-500);
        for (let i = lines.length - 1; i >= 0; i--) if (/API Error|isApiErrorMessage|authentication_failed|billing_error/i.test(lines[i])) { text = lines[i]; break; }
        break;
      }
    } catch { /* no transcript: classification without it */ }
    let quota = null;
    try {
      const read = spawnSync(process.execPath, [join(__dirname, 'provider-quota.cjs'), '--json'], { encoding: 'utf8', env, timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
      if (read.status === 0 && read.stdout) quota = JSON.parse(read.stdout); // a failed quota read (also a timeout): classification without it
    } catch { /* no quota read: classification without it */ }
    record({ ...baseRow, result: RESULT.END, exit_code: exitCode, class: failureClass({ text, quota }, profile) });
  }
  if (result.error) fail(127, `cannot start claude: ${result.error.code || result.error.message}`);
  // Integrity check of .git after the worker ends: a change of the shared part (config, hooks, info/*) makes the task failed with the class integrity
  // (an event row with the class integrity, which the task journal and the result validator read), with a message for the lead on stderr (pane) and no result handed over (the lead decides).
  // The worker posts its result BEFORE claude exits, so this check can run after a verdict was read: `provider-task result` therefore also compares the baseline written above
  // with the live .git until this check has marked it, and upgrades a saved success when the row appears later. The check only detects: a hook written by the worker may stay on disk, the lead removes it.
  if (digestBefore) {
    const difference = compareDigest(digestBefore, gitDigest(gitCwd));
    if (difference) record({ ...baseRow, result: RESULT.INTEGRITY, class: FAILURE_CLASSES.INTEGRITY, git_change: difference, launcher_exit: result.status ?? (result.signal ? `signal:${result.signal}` : null) });
    if (baseline) markBaselineChecked(baseline); // after the row: from here on the wrapper verdict decides, not a later live comparison
    if (difference) fail(1, `the shared part of .git of the repository (${gitCwd}) changed while the worker ran: ${difference}; task failed (class integrity), the result is not handed over; the check only detects: a hook written by the worker may have stayed on disk, the lead removes it`);
  }
  // Exit code: a signal to the wrapper wins over the child signal and the child code (wrapper interrupted: 128 + that signal, also when the child ignored it and ended normally);
  // otherwise the child code, or 128 + the child signal number.
  process.exit(interrupted ? signalCode(interrupted) : result.signal ? signalCode(result.signal) : result.status ?? 0);
})();
