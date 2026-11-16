#!/usr/bin/env node
// OMC Post-Tool-Use-Failure Hook (Node.js)
// Tracks tool failures for retry guidance in Stop hook
// Writes last-tool-error-state.json (session-scoped) or last-tool-error.json (legacy)
// with tool name, input preview, error, and retry count

import { existsSync, readFileSync, mkdirSync } from 'fs';
import { join, sep, resolve } from 'path';
import { readStdin } from './lib/stdin.mjs';
import { atomicWriteFileSync, withStateFileLockAtPathSync } from './lib/atomic-write.mjs';
import { resolveOmcStateRoot } from './lib/state-root.mjs';
// Opt-in repeated-failure series helpers (OMC_JEV_FAILURE_SERIES=1): the series key, the nudge
// and final thresholds. Unused while the switch is off.
import { errorSeriesKey, finalThreshold, nudgeThreshold } from './lib/jev-failure-signature.mjs';

// ============================================================================
// Session ID resolution (mirrors src/lib/session-id.ts — inlined for .mjs)
// Precedence in hook context: payload wins over env var.
// ============================================================================

/**
 * Resolve the session id for hook context.
 * Payload session_id takes priority; falls back to OMC_SESSION_ID env var.
 *
 * @param {object|null} hookPayload - Parsed stdin payload (may be null)
 * @returns {string|undefined}
 */
function resolveHookSessionId(hookPayload) {
  const payloadId =
    hookPayload &&
    typeof hookPayload === 'object' &&
    typeof hookPayload.session_id === 'string' &&
    hookPayload.session_id.trim()
      ? hookPayload.session_id.trim()
      : undefined;

  const envId =
    process.env.OMC_SESSION_ID && process.env.OMC_SESSION_ID.trim()
      ? process.env.OMC_SESSION_ID.trim()
      : undefined;

  return payloadId ?? envId;
}

// ============================================================================
// Session ID validation (mirrors src/lib/worktree-paths.ts)
// ============================================================================

const SESSION_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;

/**
 * Validate session id to prevent path traversal.
 * Returns the id if valid, undefined otherwise.
 *
 * @param {string|undefined} sessionId
 * @returns {string|undefined}
 */
function validateSessionId(sessionId) {
  if (!sessionId) return undefined;
  if (sessionId.includes('..') || sessionId.includes('/') || sessionId.includes('\\')) return undefined;
  if (!SESSION_ID_REGEX.test(sessionId)) return undefined;
  return sessionId;
}

// Use the same process-identity-aware state lock as the cleanup hook.
// run.cjs gives 3s hooks a 2.5s inner budget; share a 1.8s monotonic deadline
// across acquisition and release, with bounded SQLite and process-probe waits.
const POST_TOOL_FAILURE_LOCK_ATTEMPTS = 50;
const POST_TOOL_FAILURE_SQLITE_TIMEOUT_MS = 600;
const POST_TOOL_FAILURE_PROCESS_PROBE_TIMEOUT_MS = 900;
const POST_TOOL_FAILURE_TOTAL_TIMEOUT_MS = 1800;

function withFileLockSync(filePath, fn) {
  const result = withStateFileLockAtPathSync(
    `${filePath}.lock`,
    fn,
    true,
    POST_TOOL_FAILURE_LOCK_ATTEMPTS,
    POST_TOOL_FAILURE_SQLITE_TIMEOUT_MS,
    POST_TOOL_FAILURE_PROCESS_PROBE_TIMEOUT_MS,
    POST_TOOL_FAILURE_TOTAL_TIMEOUT_MS,
  );
  return result.acquired || result.callbackRan;
}

// ============================================================================
// State path resolution (mirrors resolveSessionStatePaths logic)
// ============================================================================

/**
 * Resolve state file paths for a given omc root and optional session id.
 * Session-scoped: <omcRoot>/state/sessions/<sid>/last-tool-error-state.json
 * Legacy:         <omcRoot>/state/last-tool-error.json
 *
 * @param {string} omcRoot
 * @param {string|undefined} sessionId
 * @returns {{ statePath: string, stateDir: string }}
 */
function resolveErrorStatePaths(omcRoot, sessionId) {
  if (sessionId) {
    const sessionDir = join(omcRoot, 'state', 'sessions', sessionId);
    return {
      stateDir: sessionDir,
      statePath: join(sessionDir, 'last-tool-error-state.json'),
    };
  }
  const stateDir = join(omcRoot, 'state');
  return {
    stateDir,
    statePath: join(stateDir, 'last-tool-error.json'),
  };
}

// Constants
const RETRY_WINDOW_MS = 60000; // 60 seconds
// Package gap of the one-attempt-per-model-response rule: two failures of one series within this
// window count as a single attempt when no stronger package key is available.
const PACKAGE_GAP_MS = 2000;
// Byte limit of the series state file (progressive string-field cuts keep the file under it).
const STATE_LIMIT_BYTES = 4096;
// Do not persist tool input or raw errors: either can contain credentials.
const GENERIC_ERROR_CLASS = 'Tool execution failed (details omitted for privacy).';
const OPTIONAL_STARTUP_READ_TOOL_NAMES = new Set([
  'mcp__omx_state__state_read',
  'mcp__omx_state__state_get_status',
  'mcp__omx_state__state_list_active',
  'mcp__omx_memory__notepad_read',
  'mcp__omx_memory__project_memory_read',
]);

function getToolInputCommand(toolInput) {
  if (typeof toolInput === 'string') {
    return toolInput;
  }
  if (!toolInput || typeof toolInput !== 'object') {
    return '';
  }

  const candidateKeys = ['command', 'cmd', 'bash_command', 'script', 'query'];
  for (const key of candidateKeys) {
    const value = toolInput[key];
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }

  return '';
}

function isPermissionDeniedScanLine(line) {
  return /^(?:find|grep|rg): .*permission denied$/i.test(line.trim());
}

function shouldSuppressFilesystemScanPermissionNoise(toolName, toolInput, error) {
  if (String(toolName || '').toLowerCase() !== 'bash') {
    return false;
  }

  const command = getToolInputCommand(toolInput).trim();
  if (!command) {
    return false;
  }

  const looksLikeBroadScan =
    /\bAGENTS\.md\b/i.test(command) ||
    /\b(?:find|grep|rg)\b[\s\S]*?(?:\.\.|\/)/i.test(command);
  if (!looksLikeBroadScan) {
    return false;
  }

  const lines = String(error || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const permissionLines = lines.filter(isPermissionDeniedScanLine);
  if (permissionLines.length === 0) {
    return false;
  }

  const nonNoiseLines = lines.filter((line) => {
    if (isPermissionDeniedScanLine(line)) return false;
    if (/^(?:command failed with exit code \d+:|exit code \d+)$/i.test(line)) return false;
    if (line === command) return false;
    return true;
  });

  return nonNoiseLines.length === 0;
}

// Validate that targetPath is contained within basePath (prevent path traversal)
function isPathContained(targetPath, basePath) {
  const normalizedTarget = resolve(targetPath);
  const normalizedBase = resolve(basePath);
  return normalizedTarget.startsWith(normalizedBase + sep) || normalizedTarget === normalizedBase;
}

// Initialize .omc directory if needed; returns the omc root (not state subdir)
async function initOmcDir(directory) {
  const cwd = process.cwd();
  // Validate directory is contained within cwd
  if (!isPathContained(directory, cwd)) {
    // Fallback to cwd if directory attempts traversal
    directory = cwd;
  }
  const omcDir = await resolveOmcStateRoot(directory);
  const stateDir = join(omcDir, 'state');

  if (!existsSync(omcDir)) {
    try { mkdirSync(omcDir, { recursive: true }); } catch {}
  }
  if (!existsSync(stateDir)) {
    try { mkdirSync(stateDir, { recursive: true }); } catch {}
  }

  return omcDir;
}

// Read existing error state
function readErrorState(statePath) {
  try {
    if (!existsSync(statePath)) return null;
    const content = readFileSync(statePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// Calculate retry count
function calculateRetryCount(existingState, toolName, currentTime) {
  if (!existingState || existingState.tool_name !== toolName) {
    return 1; // First failure for this tool
  }

  const lastErrorTime = new Date(existingState.timestamp).getTime();
  // Guard against NaN from invalid timestamps
  if (!Number.isFinite(lastErrorTime)) {
    return 1; // Treat as first failure if timestamp is invalid
  }
  const timeDiff = currentTime - lastErrorTime;

  if (timeDiff > RETRY_WINDOW_MS) {
    return 1; // Outside retry window, reset count
  }

  return (existingState.retry_count || 1) + 1;
}

// Repeated-failure series, keyed by (tool, error signature) instead of the bare tool name. A
// mutating command with a recognized target path keys the series by the path instead, so one file
// ground in a circle by different methods is one series. The window and the package rule (one
// attempt per model response) follow the retry window above.
function countFailureSeries(existingState, toolName, seriesKey, currentTime, packageKey) {
  const sameSeries = existingState
    && existingState.version === 2 // an old (pre-series) or broken state starts a fresh series
    && existingState.tool_name === toolName
    && existingState.error_key === seriesKey
    && Number.isFinite(new Date(existingState.timestamp).getTime());
  if (!sameSeries || currentTime - new Date(existingState.timestamp).getTime() > RETRY_WINDOW_MS) {
    return { n: 1, newAttempt: true, newSeries: true };
  }
  const samePackage = packageKey
    ? (existingState.package_key === packageKey)
    : (currentTime - (existingState.package_ts || 0) < PACKAGE_GAP_MS);
  if (samePackage) return { n: existingState.retry_count || 1, newAttempt: false }; // one attempt per response: no counting
  return { n: (existingState.retry_count || 1) + 1, newAttempt: true };
}

// Steering texts of a series. The nudge fires once per series at the nudge threshold; at the
// final threshold the final state fires once per series.
function seriesNudgeText(toolName, n) {
  return `[OMC FAILURE SERIES] Tool "${toolName}" returned the same error signature ${n} times in this series. Do not repeat the same action: inspect the latest failure, name the cause, pick a materially different approach (a different tool or different input) and run the narrowest verifying step; if the same error returns after two failed methods, end the turn with a line \`BLOCKED: <reason, at least 20 characters>\`. Do not write a report about this notice: at most one short sentence and resume the task.`;
}

function seriesEndStateText(toolName, n) {
  return `[OMC FAILURE SERIES: FINAL] Tool "${toolName}" has failed ${n} times with the same signature: two different methods failed. Stop retrying the same approach: try a different command or check dependencies; if the remaining work cannot be performed, end the turn with a line \`BLOCKED: <reason, at least 20 characters>\`; further repeats of the same action change nothing.`;
}

// Write the failure-series state (version 2) under a hard byte limit: when the JSON exceeds it,
// string fields are progressively cut until it fits. Fail-open like the base write.
function writeFailureSeriesState(stateDir, toolName, retryCount, statePath, additional = {}) {
  const resolvedPath = statePath || join(stateDir, 'last-tool-error.json');

  let errorState = {
    version: 2,
    tool_name: toolName,
    error: GENERIC_ERROR_CLASS,
    timestamp: new Date().toISOString(),
    retry_count: retryCount,
    ...additional,
  };

  try {
    let text = JSON.stringify(errorState, null, 2);
    if (Buffer.byteLength(text) > STATE_LIMIT_BYTES) {
      let trimmed = { ...errorState };
      for (const limit of [1200, 800, 400, 200, 100, 50, 20, 8]) {
        for (const k of Object.keys(trimmed)) {
          if (typeof trimmed[k] === 'string' && trimmed[k].length > limit) trimmed[k] = trimmed[k].slice(0, limit);
        }
        text = JSON.stringify(trimmed, null, 2);
        if (Buffer.byteLength(text) <= STATE_LIMIT_BYTES) break;
      }
      errorState = trimmed;
    }
    atomicWriteFileSync(resolvedPath, text);
  } catch {}
}

// Write error state to a pre-resolved statePath (session-scoped or legacy)
function writeErrorState(stateDir, toolName, retryCount, statePath) {
  const resolvedPath = statePath || join(stateDir, 'last-tool-error.json');

  const errorState = {
    tool_name: toolName,
    error: GENERIC_ERROR_CLASS,
    timestamp: new Date().toISOString(),
    retry_count: retryCount,
  };

  try {
    atomicWriteFileSync(resolvedPath, JSON.stringify(errorState, null, 2));
  } catch {}
}

function shouldSuppressOptionalStartupMethodNotFound(toolName, error) {
  if (!OPTIONAL_STARTUP_READ_TOOL_NAMES.has(toolName)) {
    return false;
  }

  return /\bmethod not found\b/i.test(String(error || ''));
}

async function main() {
  // Skip guard: honor DISABLE_OMC and OMC_SKIP_HOOKS (see issues #838, #3253).
  // Token `post-tool-use-failure` is preferred; `post-tool-use` is accepted for
  // compatibility with the sibling PostToolUse hook (post-tool-verifier.mjs).
  const _skipHooks = (process.env.OMC_SKIP_HOOKS || '').split(',').map(s => s.trim());
  if (
    process.env.DISABLE_OMC === '1' ||
    process.env.DISABLE_OMC === 'true' ||
    _skipHooks.includes('post-tool-use-failure') ||
    _skipHooks.includes('post-tool-use')
  ) {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  try {
    const input = await readStdin();
    const data = JSON.parse(input);

    // Opt-in shell checks (OMC_SHELL_CHECKS=1): record known Bash/PowerShell error classes. Never affects the hook.
    if (process.env.OMC_SHELL_CHECKS === '1' && (data?.tool_name === 'Bash' || data?.tool_name === 'PowerShell')) {
      try {
        const { hasShellToolError, recordShellToolErrors } = await import('./lib/shell-checks.mjs');
        if (hasShellToolError(data)) {
          const stateRoot = await resolveOmcStateRoot(data.cwd || data.directory || process.cwd());
          recordShellToolErrors('post-tool-use-failure', data, { logDir: join(stateRoot, 'state', 'shell-checks') });
        }
      } catch { /* best-effort */ }
    }

    // Last tool error for the work-state registry of the opt-in Jev compaction point.
    if ((process.env.OMC_JEV || '').includes('compaction') && !data?.is_interrupt) {
      try {
        (await import('./lib/jev-compaction-state.mjs')).recordCompactionState('failure', data);
      } catch { /* never breaks the hook */ }
    }

    // Official SDK fields (snake_case)
    const toolName = data.tool_name || '';
    const toolInput = data.tool_input;
    const error = data.error || '';
    const isInterrupt = data.is_interrupt || false;
    const directory = data.cwd || data.directory || process.cwd();

    // Ignore user interrupts
    if (isInterrupt) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    // Skip if no tool name or error
    if (!toolName || !error) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    if (shouldSuppressOptionalStartupMethodNotFound(toolName, error)) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    if (shouldSuppressFilesystemScanPermissionNoise(toolName, toolInput, error)) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    // Resolve session id: payload wins over env var (hook context)
    const rawSessionId = resolveHookSessionId(data);
    const sessionId = validateSessionId(rawSessionId);

    // Initialize .omc root directory
    const omcRoot = await initOmcDir(directory);

    // Resolve state paths (session-scoped or legacy)
    const { stateDir, statePath } = resolveErrorStatePaths(omcRoot, sessionId);

    // Ensure session state dir exists when session-scoped
    if (sessionId) {
      try { mkdirSync(stateDir, { recursive: true }); } catch {}
    }

    // Opt-in repeated-failure series (OMC_JEV_FAILURE_SERIES=1, default off): failures of the
    // same tool call signature are counted per session; at the nudge threshold the hook adds a
    // nudge to the guidance, at the final threshold it escalates once per series. Without the
    // variable the hook behaves exactly as before.
    const failureSeriesEnabled = String(process.env.OMC_JEV_FAILURE_SERIES ?? '').trim() === '1';

    // Hoist retryCount so it is accessible for guidance generation after the lock
    let retryCount = 1;
    let steeringText = null; // series steering text of this call (nudge or final state); null = base text
    let seriesFlags = { nudge: false, end: false };

    // Series key (tool, signature hash), or (tool, path hash) for a mutating command with a
    // recognized target path; computed only when the series is enabled.
    let signatureHash = '';
    let seriesKey = '';
    let pathHash = '';
    // The package key (one attempt per model response) is read from the transcript before the
    // state lock; it stays null while the series is off (the transcript is then not read), and
    // the time-gap fallback of countFailureSeries (PACKAGE_GAP_MS) applies when it is null.
    let packageKey = null;
    if (failureSeriesEnabled) {
      ({ hash: signatureHash, key: seriesKey, pathHash } = errorSeriesKey(toolName, toolInput, error));
      const { lastAssistantMessageId } = await import('./lib/jev-denial-counter.mjs');
      packageKey = lastAssistantMessageId(
        typeof data.transcript_path === 'string' && data.transcript_path ? data.transcript_path : undefined,
      );
    }

    // Read-compute-write under lock to prevent concurrent retryCount corruption
    const stateWriteCompleted = withFileLockSync(statePath, () => {
      // Read existing state and calculate the retry count (or the series number when enabled)
      const existingState = readErrorState(statePath);
      const currentTime = Date.now();
      if (!failureSeriesEnabled) {
        retryCount = calculateRetryCount(existingState, toolName, currentTime);
        writeErrorState(stateDir, toolName, retryCount, statePath);
        return;
      }
      const series = countFailureSeries(existingState, toolName, seriesKey, currentTime, packageKey);
      retryCount = series.n;
      // A fresh series starts with fresh flags; flags are latched per series (each fires once).
      const previous = (series.newSeries || !existingState)
        ? { nudge: false, end: false }
        : { nudge: existingState.nudge_sent === 1, end: existingState.end_sent === 1 };
      if (series.newAttempt) { // a package member fires nothing (one attempt per model response)
        if (series.n >= finalThreshold() && !previous.end) { // final state fires once per series
          steeringText = seriesEndStateText(toolName, series.n);
          seriesFlags = { nudge: true, end: true };
        } else if (series.n >= nudgeThreshold() && !previous.nudge && !previous.end) { // nudge fires once per series
          steeringText = seriesNudgeText(toolName, series.n);
          seriesFlags = { nudge: true, end: false };
        } else {
          seriesFlags = previous;
        }
      } else {
        seriesFlags = previous;
      }

      // Write the failure-series state (version 2)
      writeFailureSeriesState(stateDir, toolName, retryCount, statePath, {
        signature_hash: signatureHash,
        path_hash: pathHash,
        error_key: seriesKey,
        package_key: packageKey || null,
        package_ts: currentTime,
        nudge_sent: seriesFlags.nudge ? 1 : 0,
        end_sent: seriesFlags.end ? 1 : 0,
      });
    });
    if (!stateWriteCompleted) {
      console.error('[omc-tool-failure] state write skipped because the exclusive lock was unavailable');
    }

    // Inject continuation guidance so the model analyzes the error instead of stopping.
    // Without this, PostToolUseFailure returns silently and the model may end its turn.
    // The PostToolUse hook (post-tool-verifier.mjs) provides similar guidance for
    // successful Bash calls with error patterns, but PostToolUseFailure is a separate
    // event that needs its own guidance injection.
    let guidance;
    if (steeringText) {
      // A fired nudge or final state replaces the base text (each fires once per series).
      guidance = steeringText;
    } else if (!failureSeriesEnabled && retryCount >= 5) {
      guidance = `Tool "${toolName}" has failed ${retryCount} times. Stop retrying the same approach — try a different command, check dependencies, or ask the user for guidance.`;
    } else {
      guidance = `Tool "${toolName}" failed. Analyze the error, fix the issue, and continue working.`;
    }

    console.log(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PostToolUseFailure',
        additionalContext: guidance,
      },
    }));
  } catch (error) {
    // Never block on hook errors
    console.log(JSON.stringify({ continue: true }));
  }
}

main();
