'use strict';
// Registration of the worker hooks that deny AskUserQuestion and count tool calls
// (script: provider-hook-need.cjs). The denial text is shared with the script; a test keeps both literals equal.

const { shellQuote } = require('./settings.cjs');

// Denial text for AskUserQuestion and for an exhausted tool-call limit: actionable for the agent.
const NEED_TEXT = 'Do not retry. Write a single NEED: line with your request to the lead and finish.';

// Hook command that survives a missing script, built like the guard command (checks with [ -f ], runs the script with node).
// For AskUserQuestion a missing script means a denial (JSON deny with NEED_TEXT, fail-closed); for the counter it means a silent pass
// (no else branch: a quota protection must not stop work when it is broken itself).
function needCommand(script, denyIfMissing) {
  const run = `exec ${shellQuote(process.execPath)} "$P"`;
  if (!denyIfMissing) return `/bin/sh -c ${shellQuote(`P=${shellQuote(script)}; if [ -f "$P" ]; then ${run}; fi`)}`;
  const deny = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: NEED_TEXT } });
  return `/bin/sh -c ${shellQuote(`P=${shellQuote(script)}; if [ -f "$P" ]; then ${run}; else printf '%s\\n' ${shellQuote(deny)}; fi`)}`;
}

// Appends PreToolUse entries of the script to the settings without removing existing ones: (1) matcher AskUserQuestion
// (always registered, defence in depth next to --disallowedTools AskUserQuestion), (2) no matcher = all tools, a per-task tool-call
// counter (only when `counter` is set: the caller enables it for a positive OMC_PROVIDER_MAX_TOOL_CALLS or a task team).
function addNeed(settings, { script, counter }) {
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  hooks.PreToolUse = [...(Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : []), { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: needCommand(script, true), timeout: 10 }] }];
  if (counter) hooks.PreToolUse = [...hooks.PreToolUse, { hooks: [{ type: 'command', command: needCommand(script, false), timeout: 10 }] }];
  settings.hooks = hooks;
  return settings;
}

module.exports = { NEED_TEXT, needCommand, addNeed };
