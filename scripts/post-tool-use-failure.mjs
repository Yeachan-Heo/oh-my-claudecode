#!/usr/bin/env node
// OMC Post-Tool-Use-Failure Hook (Node.js)
// Tracks tool failures for retry guidance in Stop hook
// Writes last-tool-error-state.json (session-scoped) or last-tool-error.json (legacy)
// with tool name, input preview, error, and retry count

import { existsSync, readFileSync, mkdirSync, openSync, closeSync, unlinkSync, writeSync, statSync, constants as fsConstants } from 'fs';
import { join, sep, resolve, dirname } from 'path';
import { readStdin } from './lib/stdin.mjs';
import { atomicWriteFileSync, ensureDirSync } from './lib/atomic-write.mjs';
import { resolveOmcStateRoot } from './lib/state-root.mjs';

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

// ============================================================================
// Inline file lock (mirrors src/lib/file-lock.ts — O_CREAT|O_EXCL pattern)
// No TS import available in .mjs; implement the same algorithm inline.
// NOTE: This block is intentionally duplicated in templates/hooks/post-tool-use-failure.mjs.
// No shared .mjs helper exists for hooks; do not factor out without first creating one.
// ============================================================================

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_DELAY_MS = 50;
const LOCK_TIMEOUT_MS = 2_000;

/**
 * Derive lock file path for a given data file.
 * @param {string} filePath
 * @returns {string}
 */
function lockPathFor(filePath) {
  return filePath + '.lock';
}

/**
 * Check whether an existing lock file is stale (old + dead PID).
 * @param {string} lockPath
 * @returns {boolean}
 */
function isLockStale(lockPath) {
  try {
    const stat = statSync(lockPath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < LOCK_STALE_MS) return false;
    try {
      const raw = readFileSync(lockPath, 'utf-8');
      const payload = JSON.parse(raw);
      if (payload.pid) {
        // Check if process is alive: sending signal 0 throws if dead
        try { process.kill(payload.pid, 0); return false; } catch { /* dead */ }
      }
    } catch { /* malformed — stale if old enough */ }
    return true;
  } catch {
    return false; // disappeared
  }
}

/**
 * Try to acquire the lock once (single O_CREAT|O_EXCL attempt).
 * @param {string} lockPath
 * @returns {{fd: number, path: string}|null}
 */
function tryAcquireLockSync(lockPath) {
  ensureDirSync(dirname(lockPath));
  try {
    const fd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, timestamp: Date.now() }), null, 'utf-8');
    } catch (writeErr) {
      try { closeSync(fd); } catch { /* ignore */ }
      try { unlinkSync(lockPath); } catch { /* ignore */ }
      throw writeErr;
    }
    return { fd, path: lockPath };
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      if (isLockStale(lockPath)) {
        try { unlinkSync(lockPath); } catch { /* another process reaped it */ }
        // One retry after reaping
        try {
          const fd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
          try {
            writeSync(fd, JSON.stringify({ pid: process.pid, timestamp: Date.now() }), null, 'utf-8');
          } catch (writeErr) {
            try { closeSync(fd); } catch { /* ignore */ }
            try { unlinkSync(lockPath); } catch { /* ignore */ }
            throw writeErr;
          }
          return { fd, path: lockPath };
        } catch {
          return null;
        }
      }
      return null;
    }
    throw err;
  }
}

/**
 * Release a previously acquired lock handle.
 * @param {{fd: number, path: string}} handle
 */
function releaseLockSync(handle) {
  try { closeSync(handle.fd); } catch { /* ignore */ }
  try { unlinkSync(handle.path); } catch { /* ignore */ }
}

/**
 * Execute fn while holding an exclusive file lock.
 * Falls back to executing fn without a lock if lock cannot be acquired
 * (hook must never fail silently).
 *
 * @param {string} lockPath
 * @param {() => void} fn
 */
function withFileLockSync(lockPath, fn) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let handle = tryAcquireLockSync(lockPath);

  if (!handle) {
    // Retry loop using synchronous spin (main thread — Atomics.wait not available)
    while (!handle && Date.now() < deadline) {
      const waitUntil = Math.min(Date.now() + LOCK_RETRY_DELAY_MS, deadline);
      while (Date.now() < waitUntil) { /* spin */ }
      handle = tryAcquireLockSync(lockPath);
    }
  }

  if (!handle) {
    // Could not acquire lock — proceed without lock rather than dropping the write
    fn();
    return;
  }

  try {
    fn();
  } finally {
    releaseLockSync(handle);
  }
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
const MAX_ERROR_LENGTH = 500;
const MAX_INPUT_PREVIEW_LENGTH = 200;
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

// Truncate string to max length
function truncate(str, maxLength) {
  if (!str) return '';
  const text = String(str);
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

// Create input preview from tool_input
function createInputPreview(toolInput) {
  if (!toolInput) return '';

  try {
    // If it's an object, stringify it
    const inputStr = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput);
    return truncate(inputStr, MAX_INPUT_PREVIEW_LENGTH);
  } catch {
    return truncate(String(toolInput), MAX_INPUT_PREVIEW_LENGTH);
  }
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

// Write error state to a pre-resolved statePath (session-scoped or legacy)
function writeErrorState(stateDir, toolName, toolInputPreview, error, retryCount, statePath) {
  const resolvedPath = statePath || join(stateDir, 'last-tool-error.json');

  const errorState = {
    tool_name: toolName,
    tool_input_preview: toolInputPreview,
    error: truncate(error, MAX_ERROR_LENGTH),
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

    const lockPath = lockPathFor(statePath);

    // Hoist retryCount so it is accessible for guidance generation after the lock
    let retryCount = 1;

    // Read-compute-write under lock to prevent concurrent retryCount corruption
    withFileLockSync(lockPath, () => {
      // Read existing state and calculate retry count
      const existingState = readErrorState(statePath);
      const currentTime = Date.now();
      retryCount = calculateRetryCount(existingState, toolName, currentTime);

      // Create input preview
      const inputPreview = createInputPreview(toolInput);

      // Write error state
      writeErrorState(stateDir, toolName, inputPreview, error, retryCount, statePath);
    });

    // Inject continuation guidance so the model analyzes the error instead of stopping.
    // Without this, PostToolUseFailure returns silently and the model may end its turn.
    // The PostToolUse hook (post-tool-verifier.mjs) provides similar guidance for
    // successful Bash calls with error patterns, but PostToolUseFailure is a separate
    // event that needs its own guidance injection.
    let guidance;
    if (retryCount >= 5) {
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
