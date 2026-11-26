'use strict';
// Settings for a provider session or worker: the --settings copy (env block, key helper,
// permissions, guard hook), the shim directory that puts a `claude` wrapper first on PATH,
// the key-helper command, worker argument rewriting and copy cleanup.

const { spawnSync } = require('node:child_process');
const { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } = require('node:fs');
const { basename, join, resolve } = require('node:path');
const { ProfileError, stateDirOf, WORKER_TOOLS, expandHome } = require('./profile.cjs');
const { providerEnv } = require('./env.cjs');

const DEFAULT_HELPER = join(__dirname, '..', 'provider-key-helper.cjs');
const GUARD_MATCHER = 'Bash|Edit|Write|MultiEdit|NotebookEdit|Read|Grep|Glob';
const EXECUTOR_TOOLS = WORKER_TOOLS.join(',');
const SHIM_NAME_RE = /^[A-Za-z0-9._-]+$/;

const COMMAND_NAMES = Object.freeze([
  'provider-launch',
  'provider-worker',
  'provider-team',
  'provider-task',
  'provider-quota',
  'provider-quota-guard',
  'provider-proxy',
  'provider-advisor',
]);

// Copies of --settings files written per start: session copies end with "-provider.json",
// worker and doctor copies start with their role prefix. Other files in the directory are left alone.
const COPY_PATTERN = /^(?:provider|worker|doctor|task)-.*\.json$|-provider\.json$/;

const GIT_RULE = 'Do not use `git config` with a write, or `git remote add|set-url|remove|rename|prune`: in a linked worktree they write the shared `.git/config` and change the commit author and the remotes of the repository in every worktree.';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Command for apiKeyHelper: the helper reads the profile named in the command, so the profiles file
// path is passed through the environment of the helper itself (no dependence on the caller's env).
function keyHelperCommand(profile, env = process.env, helperPath = DEFAULT_HELPER) {
  const file = profile.file ?? env.OMC_PROVIDER_PROFILES_FILE;
  const prefix = file ? `env OMC_PROVIDER_PROFILES_FILE=${shellQuote(file)} ` : '';
  return `${prefix}${shellQuote(process.execPath)} ${shellQuote(helperPath)} --profile ${shellQuote(profile.name)}`;
}

// Key read through the helper, in memory only. The result never includes a path or the key in an error.
function readKey(profile, env = process.env, helperPath = DEFAULT_HELPER) {
  const childEnv = { ...env };
  if (profile.file) childEnv.OMC_PROVIDER_PROFILES_FILE = profile.file;
  const run = spawnSync(process.execPath, [helperPath, '--profile', profile.name], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env: childEnv,
    encoding: 'utf8',
    timeout: 15000,
  });
  if (run.error) return { error: 'API key helper cannot be started; start aborted, claude was not launched' };
  if (run.status !== 0 || !run.stdout) {
    return { error: 'no usable provider API key (file missing, empty, or with whitespace inside); start aborted, claude was not launched' };
  }
  return { key: run.stdout };
}

// PreToolUse guard command. If the guard is missing or fails, the tool call is denied (fail-closed).
function guardCommand(guardPath) {
  const deny = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'Provider Bash guard is unavailable or exited with an error; the command is blocked (fail-closed).',
    },
  });
  const inner = `P=${shellQuote(guardPath)}; if [ -f "$P" ]; then ${shellQuote(process.execPath)} "$P" || printf '%s\\n' ${shellQuote(deny)}; else printf '%s\\n' ${shellQuote(deny)}; fi`;
  return `/bin/sh -c ${shellQuote(inner)}`;
}

function shimDir(profile, env = process.env, kind = 'session') {
  const override = typeof env.OMC_PROVIDER_SHIM_DIR === 'string' && env.OMC_PROVIDER_SHIM_DIR.trim() !== '' ? env.OMC_PROVIDER_SHIM_DIR : null;
  if (override) return resolve(expandHome(override));
  return join(stateDirOf(profile, env), kind === 'worker' ? 'shims-worker' : 'shims');
}

function shimBody(name, target) {
  return [
    '#!/bin/sh',
    `# Generated provider shim "${name}". Do not edit; rewritten on every start.`,
    `T=${shellQuote(target)}`,
    `[ -f "$T" ] || { echo "provider shim ${name}: target missing; start aborted" >&2; exit 3; }`,
    `exec ${shellQuote(process.execPath)} "$T" "$@"`,
    '',
  ].join('\n');
}

// Writes the shims (claude, profile.shimNames, extra) and returns their directory.
// Each shim execs the target script with node after checking that the target exists (exit 3 otherwise).
function installShims(profile, env = process.env, { target, extra = {}, kind = 'session' } = {}) {
  const dir = shimDir(profile, env, kind);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const realTarget = realpathSync(target);
  const shims = new Map([['claude', realTarget]]);
  for (const name of profile.shimNames) shims.set(name, realTarget);
  for (const [name, source] of Object.entries(extra)) shims.set(name, realpathSync(source));
  for (const [name, dest] of shims) {
    if (!SHIM_NAME_RE.test(name)) throw new ProfileError('bad_field', `shim name ${JSON.stringify(name)} must use letters, digits, dot, dash or underscore`);
    const file = join(dir, name);
    const body = shimBody(name, dest);
    let current = null;
    try { current = readFileSync(file, 'utf8'); } catch { /* not written yet */ }
    if (current === body) continue;
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, body, { mode: 0o755 });
    chmodSync(tmp, 0o755);
    renameSync(tmp, file);
  }
  return dir;
}

// Adds everything the provider does to a session settings object: env block (provider env, markers,
// PATH with shims, optional token and prefixes), apiKeyHelper or the token itself, the executor
// permission allow-list, and the guard hook.
function addProvider(settings, opts) {
  const {
    profile,
    baseUrl = profile.baseUrl,
    helperPath = DEFAULT_HELPER,
    env = process.env,
    file,
    target,
    guardPath,
    key,
    keyInProcessEnv,
    extraShims = {},
    executor = false,
    proxyPort,
  } = opts;
  const shims = installShims(profile, env, { target, extra: extraShims });
  const next = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
  next.env = {
    ...(next.env && typeof next.env === 'object' && !Array.isArray(next.env) ? next.env : {}),
    ...providerEnv(profile, baseUrl),
    OMC_PROVIDER: profile.name,
    OMC_PROVIDER_SETTINGS_FILE: file,
    PATH: `${shims}:${env.PATH || '/usr/local/bin:/usr/bin:/bin'}`, // without a PATH in the environment: the standard POSIX search path
    ...(key ? { ANTHROPIC_AUTH_TOKEN: key } : {}),
    OMC_PROVIDER_GUARD: guardEnv(profile),
    OMC_PROVIDER_STATE_DIR: stateDirOf(profile, env),
    ...(profile.modelIdPrefixes.length ? { OMC_PROVIDER_MODEL_PREFIXES: profile.modelIdPrefixes.join(',') } : {}),
    ...(proxyPort ? { OMC_ALLOW_LOOPBACK_PROXY_PORT: String(proxyPort) } : {}),
  };
  // A token in the env (file or process) makes apiKeyHelper redundant; Claude Code warns when both are set.
  if (key || keyInProcessEnv) delete next.apiKeyHelper;
  else next.apiKeyHelper = keyHelperCommand(profile, env, helperPath);
  if (executor) {
    const current = next.permissions && typeof next.permissions === 'object' && !Array.isArray(next.permissions) ? next.permissions : {};
    next.permissions = { ...current, allow: [...profile.worker.tools] };
  }
  const hooks = next.hooks && typeof next.hooks === 'object' ? next.hooks : {};
  const existing = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  hooks.PreToolUse = [...existing, { matcher: GUARD_MATCHER, hooks: [{ type: 'command', command: guardCommand(guardPath), timeout: 10 }] }];
  next.hooks = hooks;
  return next;
}

// The real `claude` binary: OMC_PROVIDER_CLAUDE_BIN (override, also used by tests), then
// profile.claudeBinary, then the first `claude` on PATH outside the shim directories. Returns
// null when there is none, or when it resolves to `selfPath` (the wrapper must never start itself).
function resolveClaudeBinary(profile, env = process.env, selfPath = null) {
  const set = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
  let self = null;
  try { self = selfPath ? realpathSync(selfPath) : null; } catch { /* unresolvable wrapper path */ }
  const usable = (file) => {
    try {
      accessSync(file, constants.X_OK);
      return realpathSync(file) !== self;
    } catch { return false; }
  };
  // A generated shim is never the real binary, wherever its directory is on PATH.
  const isShim = (file) => { try { return readFileSync(file, 'utf8').slice(0, 200).includes('Generated provider shim'); } catch { return false; } };
  const explicit = set(env.OMC_PROVIDER_CLAUDE_BIN) ?? set(profile.claudeBinary);
  if (explicit) return existsSync(explicit) && usable(explicit) ? explicit : null;
  for (const dir of String(env.PATH || '').split(':').filter(Boolean)) {
    const candidate = join(dir, 'claude');
    if (existsSync(candidate) && usable(candidate) && !isShim(candidate)) return candidate;
  }
  return null;
}

// Removes stale copies (older than `days` days). Only names that match COPY_PATTERN are removed.
function sweepCopies(dir, days = 2) {
  const limit = Date.now() - days * 86400_000;
  try {
    for (const name of readdirSync(dir)) {
      if (!COPY_PATTERN.test(name)) continue;
      const file = join(dir, name);
      try {
        if (statSync(file).mtimeMs < limit) unlinkSync(file);
      } catch { /* raced with another start */ }
    }
  } catch { /* directory missing */ }
}

// Worker arguments: drops --dangerously-skip-permissions, adds the git rule to the system prompt,
// sets the tool list and the dontAsk permission mode. Arguments after `--` are kept as they are.
function workerArgs(args, profile) {
  const tools = (profile?.worker?.tools ?? WORKER_TOOLS).join(',');
  const end = args.indexOf('--');
  const options = end < 0 ? [...args] : args.slice(0, end);
  const afterEnd = end < 0 ? [] : args.slice(end);
  const clean = [];
  let gitRuleAdded = false;
  for (let i = 0; i < options.length; i++) {
    if (options[i] === '--dangerously-skip-permissions') continue;
    if (options[i] === '--append-system-prompt' && typeof options[i + 1] === 'string') {
      clean.push(options[i], `${options[i + 1]}\n${GIT_RULE}`);
      gitRuleAdded = true;
      i++;
      continue;
    }
    if (options[i].startsWith('--append-system-prompt=')) {
      clean.push(`${options[i]}\n${GIT_RULE}`);
      gitRuleAdded = true;
      continue;
    }
    clean.push(options[i]);
  }
  return [
    ...clean,
    ...(gitRuleAdded ? [] : ['--append-system-prompt', GIT_RULE]),
    '--tools', tools,
    '--permission-mode', 'dontAsk',
    ...afterEnd,
  ];
}

// Turns the compaction point of the OMC_JEV judgment points off for print-mode sessions, where
// compaction cannot run: every compaction entry becomes compaction:off, and one is appended when
// missing. Empty and "off" values are returned unchanged.
function jevWithoutCompaction(value) {
  const text = String(value ?? '');
  if (!text.trim() || text.trim() === 'off') return text;
  const points = text.split(',').map((p) => p.trim()).filter(Boolean);
  if (points.some((p) => p.split(':')[0] === 'compaction')) {
    return points.map((p) => (p.split(':')[0] === 'compaction' ? 'compaction:off' : p)).join(',');
  }
  return [...points, 'compaction:off'].join(',');
}

// Regular expression source that matches `text` literally.
const escapeRegExp = (text) => String(text).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// JSON for OMC_PROVIDER_GUARD: the guard reads its lists from here. The patterns that protect the files of the profile are built here:
// the key file, the profiles file and the settings copies directory (matched by name, so `~/...`, `$HOME/...` and a relative name after `cd` are
// covered too; a key file with a very generic name also blocks commands that merely contain that name), followed by the configured patterns.
function guardEnv(profile) {
  const derived = [];
  for (const file of [profile.apiKey && profile.apiKey.file, profile.file]) {
    if (typeof file === 'string' && file) derived.push(`(^|[^A-Za-z0-9_])${escapeRegExp(basename(file))}`);
  }
  derived.push('worker-settings', 'git-baseline'); // the copies of the session settings and the git baselines of the workers (the integrity check reads them)
  return JSON.stringify({
    blockedCommands: profile.guard.blockedCommands,
    allowedCommands: profile.guard.allowedCommands,
    extraProtectedPatterns: [...derived, ...profile.guard.extraProtectedPatterns],
    extraProtectedPaths: profile.guard.extraProtectedPaths,
  });
}

module.exports = {
  DEFAULT_HELPER,
  COMMAND_NAMES,
  COPY_PATTERN,
  EXECUTOR_TOOLS,
  GIT_RULE,
  shellQuote,
  keyHelperCommand,
  readKey,
  guardCommand,
  addProvider,
  sweepCopies,
  shimDir,
  installShims,
  resolveClaudeBinary,
  workerArgs,
  jevWithoutCompaction,
  guardEnv,
};
