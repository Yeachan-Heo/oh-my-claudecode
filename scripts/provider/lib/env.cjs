'use strict';
// Environment for provider sessions and workers: the variables a session needs to
// talk to an alternative Anthropic-compatible endpoint, the deny-list that keeps them
// away from processes that must use the default provider, and the allow-list that
// builds a worker's environment from scratch.

const { isAbsolute } = require('node:path');
const { ADVISOR_EVENTS } = require('./vocab.cjs');

const CREDENTIAL_ENV = Object.freeze(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']);
const MARKER_ENV = Object.freeze(['OMC_PROVIDER', 'OMC_PROVIDER_SETTINGS_FILE']);
const FABLE_ENV = 'ANTHROPIC_DEFAULT_FABLE_MODEL';
const PROVIDER_MARKER_RE = /^OMC_PROVIDER(_|$)/;

const TIER_LABEL = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
const TIER_USE = {
  opus: 'the hardest planning and review work',
  sonnet: 'everyday implementation work',
  haiku: 'quick lookups and subagent work',
};

// A tier without its own entry (haiku) follows the sonnet entry.
function tierEntry(profile, tier) {
  return profile.models[tier] ?? profile.models.sonnet;
}

function displayName(profile, tier) {
  return profile.models[tier]?.name ?? `${TIER_LABEL[tier]} (${profile.name || 'provider'})`;
}

function displayDescription(profile, tier) {
  const id = tierEntry(profile, tier).id;
  return profile.models[tier]?.description
    ?? `${TIER_LABEL[tier]} tier: model ${id} on provider ${profile.name || 'provider'}, context ${profile.contextWindow} tokens, for ${TIER_USE[tier]}.`;
}

// Session environment for the given base URL. Credentials, the subagent model and the
// provider markers are set elsewhere (settings writer, launcher).
function providerEnv(profile, baseUrl = profile.baseUrl) {
  const entry = (tier) => tierEntry(profile, tier);
  const chosen = profile.models[profile.models.default] ?? profile.models.sonnet;
  const shellTimeout = String(profile.shellTimeoutMs);
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_MODEL: chosen.id,
    ANTHROPIC_DEFAULT_OPUS_MODEL: entry('opus').id,
    ANTHROPIC_DEFAULT_SONNET_MODEL: entry('sonnet').id,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: entry('haiku').id,
    ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: displayName(profile, 'opus'),
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: displayName(profile, 'sonnet'),
    ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: displayName(profile, 'haiku'),
    ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION: displayDescription(profile, 'opus'),
    ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION: displayDescription(profile, 'sonnet'),
    ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION: displayDescription(profile, 'haiku'),
    API_TIMEOUT_MS: String(profile.requestTimeoutMs),
    BASH_DEFAULT_TIMEOUT_MS: shellTimeout,
    BASH_MAX_TIMEOUT_MS: shellTimeout,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(profile.contextWindow),
    CLAUDE_CODE_AUTO_MODE_SERVER: '0',
    CLAUDE_CODE_AUTO_MODE_MODEL: entry('opus').id,
    CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_ERROR_REPORTING: '1',
  };
}

// Key set of providerEnv, computed from a sample profile that has no optional tiers.
const SAMPLE_PROFILE = Object.freeze({
  name: 'sample',
  baseUrl: 'https://sample.invalid/anthropic',
  models: { default: 'sonnet', opus: { id: 'sample-opus' }, sonnet: { id: 'sample-sonnet' } },
  contextWindow: 1,
  requestTimeoutMs: 1,
  shellTimeoutMs: 1,
});
// Some of these are names the host may read, so they stay in the key set.
const PROVIDER_ENV_KEYS = Object.freeze(Object.keys(providerEnv(SAMPLE_PROFILE)));

// Everything a non-provider child process must not inherit.
const DENY_ENV = Object.freeze([...new Set([...PROVIDER_ENV_KEYS, ...CREDENTIAL_ENV, ...MARKER_ENV, FABLE_ENV])]);

// Variables that the executor and its hooks receive only from the settings env block. The only other OMC_PROVIDER_* values that reach the executor
// are the validated advisor controls of the lead (ADVISOR_CONTROLS below), which the worker wrapper copies into the same block.
const HOOK_ENV = Object.freeze([
  'OMC_PROVIDER',
  'OMC_PROVIDER_SETTINGS_FILE',
  'OMC_PROVIDER_STATE_DIR',
  'OMC_PROVIDER_PROFILES_FILE',
  'OMC_PROVIDER_GUARD',
  'OMC_PROVIDER_TASK_ID',
  'OMC_PROVIDER_MAX_TOOL_CALLS',
  'OMC_PROVIDER_RESCUE',
  'OMC_PROVIDER_RESCUE_THRESHOLD',
  'OMC_PROVIDER_RESCUE_ADVISOR_LIMIT',
  'OMC_PROVIDER_ADVISOR_COMMAND',
  'OMC_PROVIDER_ADVISOR_MODEL',
  'OMC_PROVIDER_MODEL_PREFIXES',
  'OMC_ALLOW_LOOPBACK_PROXY_PORT',
]);

// Advisor controls of the lead (documented in docs/PROVIDER-WORKERS.md): the executor env drops every OMC_PROVIDER_* name, so the validated values go
// into the settings env block of the worker, where the advisor command reads them. A value that does not pass its check is not copied (the advisor
// then behaves as if it were unset). The test-only variables (OMC_PROVIDER_ADVISOR_CLAUDE_BIN, _TIMEOUT_MS, _ROLE_FILE) and the model, which has its
// own profile-aware resolution, are not in this list.
const isSwitch = (v) => v === '1';
const isPositiveInt = (v) => /^[1-9][0-9]{0,8}$/.test(v);
const isText = (v) => v.trim() !== '' && v.length <= 4096 && ![...v].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
// The files are written by the advisor in the cwd of the worker, which is the task worktree: a relative path would put them where the worker can edit them.
const isAbsolutePath = (v) => isText(v) && isAbsolute(v);
const ADVISOR_CONTROLS = Object.freeze({
  OMC_PROVIDER_ADVISOR_INPUT: isSwitch,
  OMC_PROVIDER_ADVISOR_JOURNAL: isSwitch,
  OMC_PROVIDER_ADVISOR_LIMIT: isSwitch,
  OMC_PROVIDER_ADVISOR_PROTOCOL: (v) => /^[a-z0-9-]{1,40}$/.test(v) && v !== 'final', // the final gate is fail-closed and belongs to the lead's own consultations: a rescue consultation of a worker could never pass it
  OMC_PROVIDER_ADVISOR_EVENT: (v) => Object.values(ADVISOR_EVENTS).includes(v),
  OMC_PROVIDER_ADVISOR_LIMIT_PER_TASK: isPositiveInt,
  OMC_PROVIDER_ADVISOR_LIMIT_PER_GROUP: isPositiveInt,
  OMC_PROVIDER_ADVISOR_TOP_SLOTS: isPositiveInt,
  OMC_PROVIDER_ADVISOR_QUEUE_WAIT_MS: isPositiveInt,
  OMC_PROVIDER_ADVISOR_CAP_INPUT: isPositiveInt,
  OMC_PROVIDER_ADVISOR_CAP_FILE: isPositiveInt,
  OMC_PROVIDER_ADVISOR_CAP_FILES_TOTAL: isPositiveInt,
  OMC_PROVIDER_ADVISOR_CAP_FILE_COUNT: isPositiveInt,
  OMC_PROVIDER_ADVISOR_CAP_DIFF_FILE: isPositiveInt,
  OMC_PROVIDER_ADVISOR_CAP_MATERIAL_HEAD: isPositiveInt,
  OMC_PROVIDER_ADVISOR_CAP_MATERIAL_TAIL: isPositiveInt,
  OMC_PROVIDER_ADVISOR_CAP_ADVICE: isPositiveInt,
  OMC_PROVIDER_ADVISOR_DIFF_BASE: (v) => isText(v) && !/\s/.test(v) && !v.startsWith('-'),
  OMC_PROVIDER_ADVISOR_LOG_FILE: isAbsolutePath,
  OMC_PROVIDER_ADVISOR_LIMIT_FILE: isAbsolutePath,
});

// The validated advisor controls of `env` as { name: value } for the settings env block of a worker. A value that is set but fails its check is
// reported to `skipped(name)` (the name only, never the value) and not copied.
function advisorControls(env, skipped = () => {}) {
  const result = {};
  for (const [name, valid] of Object.entries(ADVISOR_CONTROLS)) {
    const value = env[name];
    if (typeof value !== 'string' || value === '') continue;
    if (valid(value)) result[name] = value;
    else skipped(name);
  }
  return result;
}

// Allow-list for executor environments (built from these names, not by removing known ones).
const BASE_ENV = Object.freeze(['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'TZ', 'TERM', 'COLORTERM', 'TMUX', 'TMUX_PANE', 'SHELL', 'LOGNAME', 'DISABLE_AUTOUPDATER', 'DISABLE_ERROR_REPORTING']);
const SESSION_ENV = Object.freeze(['SSH_AUTH_SOCK', 'CLAUDE_CONFIG_DIR', 'XDG_RUNTIME_DIR']);
const WORKER_ENV = Object.freeze(['OMC_WORKER_LAUNCH_ATTEMPT_ID', 'OMC_STATE_DIR']);
const BASE_PREFIXES = Object.freeze(['LC_', 'OMC_TEAM_']);
const SESSION_PREFIXES = Object.freeze(['OMC_JEV']);

function isStrippedName(name) {
  return CREDENTIAL_ENV.includes(name) || PROVIDER_MARKER_RE.test(name);
}

function stripProviderEnv(env) {
  const copy = { ...env };
  for (const name of DENY_ENV) delete copy[name];
  return copy;
}

function stripOverrides(env) {
  const copy = {};
  for (const [name, value] of Object.entries(env)) {
    if (!isStrippedName(name)) copy[name] = value;
  }
  return copy;
}

// Worker environment (session = false) or session environment (session = true), built from the allow-list.
// Names from profile.envPassthrough are added on top; explicit values win over the allow-list.
function executorEnv(env, { explicit = {}, session = false, profile } = {}) {
  const passthrough = profile?.envPassthrough ?? {};
  const names = new Set([...BASE_ENV, ...(session ? SESSION_ENV : WORKER_ENV), ...(passthrough.names ?? [])]);
  const prefixes = [...BASE_PREFIXES, ...(session ? SESSION_PREFIXES : []), ...(passthrough.prefixes ?? [])];
  const result = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || isStrippedName(name)) continue;
    if (names.has(name) || prefixes.some((prefix) => name.startsWith(prefix))) result[name] = value;
  }
  return { ...result, ...explicit };
}

// True when ANTHROPIC_BASE_URL points outside Anthropic. An unparsable URL counts as foreign.
function isForeignProvider(env) {
  const base = env.ANTHROPIC_BASE_URL;
  if (!base) return false;
  try {
    const host = new URL(base).hostname;
    return !(host === 'api.anthropic.com' || host.endsWith('.anthropic.com'));
  } catch {
    return true;
  }
}

module.exports = {
  providerEnv,
  PROVIDER_ENV_KEYS,
  CREDENTIAL_ENV,
  MARKER_ENV,
  DENY_ENV,
  HOOK_ENV,
  ADVISOR_CONTROLS,
  advisorControls,
  BASE_ENV,
  stripProviderEnv,
  stripOverrides,
  executorEnv,
  isForeignProvider,
};
