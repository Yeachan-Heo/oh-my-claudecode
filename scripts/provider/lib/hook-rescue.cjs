'use strict';
// Parameters and registration of the rescue hooks of a provider worker (script: provider-hook-rescue.cjs).

const { shellQuote } = require('./settings.cjs');
const { advisorModel } = require('./profile.cjs');
const { TASK_TEAM_RE } = require('./vocab.cjs');

// Parameters of the rescue come from OMC_PROVIDER_RESCUE, OMC_PROVIDER_RESCUE_THRESHOLD, OMC_PROVIDER_RESCUE_ADVISOR_LIMIT and
// OMC_PROVIDER_ADVISOR_MODEL. A bad value of the first three: a message on stderr and the default; a bad advisor model passes
// through as null (the advisor refuses the consultation with exit code 2, it validates the value itself). The advisor model is
// resolved with the profile when one is given (advisor.defaultModel and advisor.models of the selected profile), otherwise with
// the built-in advisor defaults.
const RESCUE_MODES = new Set(['off', 'shadow', 'active']);
function rescueParams(env = process.env, stderr = (t) => process.stderr.write(t), profile = {}) {
  const value = (key, allowed, fallback) => {
    const s = String(env[key] ?? '').trim();
    if (!s) return fallback;
    if (allowed.has(s)) return s;
    stderr(`provider-rescue: ${key} has a disallowed value (${s}); using ${fallback}\n`);
    return fallback;
  };
  const number = (key, lower, fallback) => {
    const s = String(env[key] ?? '').trim();
    if (!s) return fallback;
    const n = Number(s);
    if (!Number.isInteger(n) || n < lower) { stderr(`provider-rescue: ${key} has a disallowed value (${s}); using ${fallback}\n`); return fallback; }
    return n;
  };
  return {
    mode: value('OMC_PROVIDER_RESCUE', RESCUE_MODES, 'off'),
    threshold: number('OMC_PROVIDER_RESCUE_THRESHOLD', 1, 2),
    limit: number('OMC_PROVIDER_RESCUE_ADVISOR_LIMIT', 0, 2),
    model: advisorModel(profile || {}, env),
  };
}

// Hook command that survives a missing script: with active a denial (JSON deny, like the guard command), with off and shadow a safe pass (exit 0).
function rescueCommand(script, mode) {
  const deny = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Provider rescue hook (provider-hook-rescue) is unavailable; the command is blocked (OMC_PROVIDER_RESCUE=active).' } });
  const fallback = mode === 'active' ? `printf '%s\\n' ${shellQuote(deny)}` : 'exit 0';
  return `/bin/sh -c ${shellQuote(`P=${shellQuote(script)}; if [ -f "$P" ]; then exec ${shellQuote(process.execPath)} "$P"; else ${fallback}; fi`)}`;
}

// Adds the validated parameters to the env block of the settings and, unless the mode is off, the hooks (PreToolUse, PostToolUse,
// PostToolUseFailure for Bash). The task key for the hooks comes from the team name.
function addRescue(settings, { env = process.env, team = '', script = '', profile = {} } = {}) {
  const p = rescueParams(env, undefined, profile);
  settings.env = {
    ...(settings.env && typeof settings.env === 'object' ? settings.env : {}),
    OMC_PROVIDER_RESCUE: p.mode,
    OMC_PROVIDER_RESCUE_THRESHOLD: String(p.threshold),
    OMC_PROVIDER_RESCUE_ADVISOR_LIMIT: String(p.limit),
    OMC_PROVIDER_ADVISOR_MODEL: p.model, // null after a bad value (the advisor refuses with exit code 2)
  };
  const m = TASK_TEAM_RE.exec(String(team || ''));
  if (m) settings.env.OMC_PROVIDER_TASK_ID = m[1];
  if (p.mode === 'off' || !script) return settings; // no registration when off; without a script path no hooks (the command has a fallback anyway)
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const command = rescueCommand(script, p.mode);
  for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] : []), { matcher: 'Bash', hooks: [{ type: 'command', command, timeout: 10 }] }];
  settings.hooks = hooks;
  return settings;
}

module.exports = { RESCUE_MODES, rescueParams, rescueCommand, addRescue };
