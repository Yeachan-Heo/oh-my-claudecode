// Force Agent Delegation Preflight
//
// Symmetric counterpart to evaluateAgentHeavyPreflight: where preflight blocks
// agent spawning when context is exhausted, this evaluator blocks raw
// Read/Edit/Write/Grep/Glob when delegation rules indicate the work should be
// routed to a specialised agent instead.
//
// Opt-in: default OFF. Enable via `.omc/config.json`:
//
//   {
//     "routing": {
//       "forceDelegation": {
//         "enforce": true,
//         "rules": [
//           {
//             "pattern": "Read",
//             "threshold": { "count": 10, "windowSeconds": 120 },
//             "denyMessage": "10+ raw Reads in 2 min — spawn Agent(subagent_type='oh-my-claudecode:explore', model='haiku', ...). Bypass: ALLOW_RAW_READ=1.",
//             "bypassEnv": "ALLOW_RAW_READ"
//           }
//         ]
//       }
//     }
//   }
//
// State persistence: a 1h sliding window of tool-use events is stored under
// `<stateDir>/force-agent-delegation-events.json` so the threshold counter
// survives across PreToolUse invocations (each invocation is a fresh Node
// process). State writes fail open — missing/corrupt files just reset the
// window without blocking the tool call.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const STATE_FILENAME = 'force-agent-delegation-events.json';
const EVENT_RETENTION_SECONDS = 3600;
const DEFAULT_WINDOW_SECONDS = 120;

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function loadEvents(stateDir) {
  if (!stateDir) return [];
  try {
    const p = join(stateDir, STATE_FILENAME);
    if (!existsSync(p)) return [];
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    return Array.isArray(parsed?.events) ? parsed.events : [];
  } catch {
    return [];
  }
}

function saveEvents(stateDir, events) {
  if (!stateDir) return;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, STATE_FILENAME),
      JSON.stringify({ events }, null, 2),
    );
  } catch {
    // Non-critical — counter resets if write fails.
  }
}

function pruneAndAppend(events, toolName) {
  const cutoff = nowSec() - EVENT_RETENTION_SECONDS;
  const pruned = events.filter((e) => typeof e?.t === 'number' && e.t > cutoff);
  pruned.push({ tool: toolName, t: nowSec() });
  return pruned;
}

function patternMatches(pattern, toolName) {
  if (!pattern || typeof pattern !== 'string') return false;
  try {
    return new RegExp(`^(?:${pattern})$`).test(toolName);
  } catch {
    return false;
  }
}

function countInWindow(events, pattern, windowSeconds) {
  const cutoff = nowSec() - windowSeconds;
  return events.filter(
    (e) =>
      typeof e?.t === 'number' &&
      e.t > cutoff &&
      typeof e?.tool === 'string' &&
      patternMatches(pattern, e.tool),
  ).length;
}

function readDelegationConfig(loadOmcConfig) {
  try {
    const cfg = typeof loadOmcConfig === 'function' ? loadOmcConfig() : null;
    return cfg?.routing?.forceDelegation ?? null;
  } catch {
    return null;
  }
}

/**
 * Evaluate force-agent-delegation rules for the current PreToolUse call.
 *
 * @param {object} args
 * @param {string} args.toolName - Claude Code tool name (Read|Edit|Write|...)
 * @param {string} [args.stateDir] - Directory used to persist the event window.
 *   Typically `<cwd>/.omc/state` to mirror the rest of OMC state storage.
 * @param {object} [args.env=process.env] - Environment for bypass-flag lookup.
 * @param {Function} [args.loadOmcConfig] - Function returning the resolved OMC
 *   config object. Injecting it keeps this module decoupled from the existing
 *   loader inside scripts/pre-tool-enforcer.mjs.
 * @returns {null | { decision: 'block', reason: string }}
 *   Returns null when the call should proceed unchanged (default off, no
 *   matching rule, threshold not reached, or bypass flag set).
 */
export function evaluateForceAgentDelegation({
  toolName,
  stateDir,
  env = process.env,
  loadOmcConfig,
} = {}) {
  if (!toolName) return null;

  const cfg = readDelegationConfig(loadOmcConfig);
  if (!cfg || cfg.enforce !== true || !Array.isArray(cfg.rules)) {
    return null;
  }

  // Record this attempt up front so later calls have an accurate window.
  const updated = pruneAndAppend(loadEvents(stateDir), toolName);
  saveEvents(stateDir, updated);

  for (const rule of cfg.rules) {
    if (!rule || typeof rule !== 'object') continue;
    if (!patternMatches(rule.pattern, toolName)) continue;

    if (rule.bypassEnv && env[rule.bypassEnv] === '1') continue;

    if (rule.threshold && typeof rule.threshold === 'object') {
      const count = Number.isFinite(rule.threshold.count)
        ? rule.threshold.count
        : 0;
      const windowSeconds = Number.isFinite(rule.threshold.windowSeconds)
        ? rule.threshold.windowSeconds
        : DEFAULT_WINDOW_SECONDS;
      if (count <= 0) continue;

      const observed = countInWindow(updated, rule.pattern, windowSeconds);
      if (observed >= count) {
        return {
          decision: 'block',
          reason:
            typeof rule.denyMessage === 'string' && rule.denyMessage
              ? rule.denyMessage
              : `[OMC] Force-agent-delegation: ${observed} ${toolName} in last ${windowSeconds}s ` +
                `(threshold ${count}). Delegate to an Agent instead. ` +
                `Bypass: ${rule.bypassEnv || 'ALLOW_RAW_READ'}=1.`,
        };
      }
    }
  }

  return null;
}
