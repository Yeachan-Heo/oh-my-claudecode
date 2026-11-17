#!/usr/bin/env node
'use strict';
// PreToolUse hook of a provider worker (registered by addNeed in lib/hook-need.cjs, command in the --settings file of the worker).
// Two jobs in one script:
//  1. Denial of AskUserQuestion: a background worker has nobody to ask; the denial text tells it to write one NEED: line to the lead and finish.
//     The permissionDecisionReason is actionable for the agent. It is registered always (narrow matcher); --disallowedTools AskUserQuestion
//     is the first line of defence and this hook is defence in depth.
//  2. Tool-call counter per task (second registration without a matcher, only when the launcher enables it: a positive OMC_PROVIDER_MAX_TOOL_CALLS
//     or a task team): every run of the hook counts one call in <stateDir>/tasks/<task key>/calls.json (a separate file from the rescue counter);
//     the limit comes from the max_tool_calls field of the task file <stateDir>/tasks/<id>.json, otherwise from OMC_PROVIDER_MAX_TOOL_CALLS
//     (default 0 = off). Past the limit the hook denies with a request for a summary, a NEED: line or a report and the end of the task.
//     Task key: OMC_PROVIDER_TASK_ID (8 hex), otherwise session-<session_id from the hook input>.
// Robustness: the counter protects quota, not security: a read or write error lets the call through (a quiet stderr note); AskUserQuestion is
// always denied, also for a damaged hook input (fail-closed like the guard). The task file is never modified here, so it is read without a lock
// (its writer replaces it atomically); the counter is written atomically (tmp + rename); calls of one session are sequential and parallel
// sessions use different keys, so no lock is needed.
const { mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { stateDirOf } = require('./lib/profile.cjs');

const NEED_TEXT = 'Do not retry. Write a single NEED: line with your request to the lead and finish.'; // identical to lib/hook-need.cjs (a test keeps them equal)
const stateDir = (env = process.env) => stateDirOf({ name: env.OMC_PROVIDER || 'default' }, env);

// Denial shaped like the guard: the text is in permissionDecisionReason (the channel to the model), not a notification.
const needResponse = (text) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: text } });

// Task key: OMC_PROVIDER_TASK_ID (8 hex) or session-<session_id>; null when it cannot be determined (counting is skipped).
function taskKey(input) {
  const id = process.env.OMC_PROVIDER_TASK_ID;
  if (id && /^[0-9a-f]{8}$/.test(id)) return id;
  const sid = input?.session_id;
  if (typeof sid === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(sid)) return `session-${sid}`; // only path-safe characters (session ids may be UUIDs with dashes)
  return null;
}

// Call limit: max_tool_calls (a number, 0 = off) of the task file wins over the configuration; null or a missing field falls back to
// OMC_PROVIDER_MAX_TOOL_CALLS (> 0), otherwise 0.
function callLimit(key) {
  if (key && /^[0-9a-f]{8}$/.test(key)) {
    try {
      const taskFile = JSON.parse(readFileSync(join(stateDir(), 'tasks', `${key}.json`), 'utf8'));
      if (typeof taskFile.max_tool_calls === 'number' && Number.isFinite(taskFile.max_tool_calls)) return taskFile.max_tool_calls;
    } catch { /* task file missing or damaged: fall back to the env */ }
  }
  const v = Number(process.env.OMC_PROVIDER_MAX_TOOL_CALLS);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

// Counts the call (read, +1, atomic write); null on an I/O error (let the call through without counting).
function count(key) {
  const dir = join(stateDir(), 'tasks', key);
  const file = join(dir, 'calls.json');
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let n = 0;
    try { const d = JSON.parse(readFileSync(file, 'utf8')); if (typeof d.n === 'number' && Number.isFinite(d.n)) n = d.n; } catch { /* first run */ }
    n += 1;
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ n, ts: Date.now() })}\n`);
    renameSync(tmp, file);
    return n;
  } catch (e) {
    try { process.stderr.write(`provider-hook-need: counter unavailable (${e && e.code ? e.code : 'error'})\n`); } catch { /* quiet */ }
    return null;
  }
}

// Lifecycle commands that must work even when the tool budget is exhausted: team api operations for task reporting and status transitions.
function isLifecycleCommand(input) {
  if (!input || typeof input !== 'object') return false;
  if (input.tool_name !== 'Bash') return false;
  const cmd = String(input.tool_input?.command ?? '');
  // Allow team api commands: claim-task, transition-task-status, release-task-claim, renew-task-claim, send-message, read-task
  return /\bteam\s+api\s+(claim-task|transition-task-status|release-task-claim|renew-task-claim|send-message|read-task)\b/.test(cmd);
}

// Handles the hook input (text from stdin or a parsed object in tests); null = let the call through (no response).
function hookResponse(input) {
  let parsed = null;
  try { parsed = typeof input === 'string' ? JSON.parse(input) : input; } catch { return needResponse(`${NEED_TEXT} (hook input damaged: fail-closed)`); }
  if (parsed?.tool_name === 'AskUserQuestion') return needResponse(NEED_TEXT);
  // Lifecycle commands bypass the tool budget limit
  if (isLifecycleCommand(parsed)) return null;
  const key = taskKey(parsed);
  if (!key) return null;
  const n = count(key);
  if (n === null) return null; // counter unavailable: quota protection, not security; let the call through
  const limit = callLimit(key);
  if (limit > 0 && n > limit) {
    return needResponse(`Tool call limit of the task exhausted (${n} of ${limit}). Summarize the work done, write a single NEED: line with what is missing to finish, or write the report and end the task.`);
  }
  return null;
}

module.exports = { NEED_TEXT, taskKey, callLimit, count, hookResponse, stateDir };

if (require.main === module) {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { data += c; });
  process.stdin.on('end', () => {
    const response = hookResponse(data);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    process.exit(0);
  });
}
