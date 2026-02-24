#!/usr/bin/env node
// OMC Post-Tool-Use-Failure Hook (Node.js)
// Tracks tool failures for retry guidance in Stop hook
// Writes last-tool-error.json with tool name, input preview, error, and retry count

import { existsSync, readFileSync, mkdirSync } from 'fs';
import { join, sep, resolve } from 'path';
import { readStdin } from './lib/stdin.mjs';
import { atomicWriteFileSync } from './lib/atomic-write.mjs';

// Constants
const RETRY_WINDOW_MS = 60000; // 60 seconds
const MAX_ERROR_LENGTH = 500;
const MAX_INPUT_PREVIEW_LENGTH = 200;

// Validate that targetPath is contained within basePath (prevent path traversal)
function isPathContained(targetPath, basePath) {
  const normalizedTarget = resolve(targetPath);
  const normalizedBase = resolve(basePath);
  return normalizedTarget.startsWith(normalizedBase + sep) || normalizedTarget === normalizedBase;
}

// Initialize .omc directory if needed
function initOmcDir(directory) {
  const cwd = process.cwd();
  // Validate directory is contained within cwd
  if (!isPathContained(directory, cwd)) {
    // Fallback to cwd if directory attempts traversal
    directory = cwd;
  }
  const omcDir = join(directory, '.omc');
  const stateDir = join(omcDir, 'state');

  if (!existsSync(omcDir)) {
    try { mkdirSync(omcDir, { recursive: true }); } catch {}
  }
  if (!existsSync(stateDir)) {
    try { mkdirSync(stateDir, { recursive: true }); } catch {}
  }

  return stateDir;
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

// Write error state
function writeErrorState(stateDir, toolName, toolInputPreview, error, retryCount) {
  const statePath = join(stateDir, 'last-tool-error.json');

  const errorState = {
    tool_name: toolName,
    tool_input_preview: toolInputPreview,
    error: truncate(error, MAX_ERROR_LENGTH),
    timestamp: new Date().toISOString(),
    retry_count: retryCount,
  };

  try {
    atomicWriteFileSync(statePath, JSON.stringify(errorState, null, 2));
  } catch {}
}

async function main() {
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

    // Initialize .omc/state directory
    const stateDir = initOmcDir(directory);
    const statePath = join(stateDir, 'last-tool-error.json');

    // Read existing state and calculate retry count
    const existingState = readErrorState(statePath);
    const currentTime = Date.now();
    const retryCount = calculateRetryCount(existingState, toolName, currentTime);

    // Create input preview
    const inputPreview = createInputPreview(toolInput);

    // Write error state
    writeErrorState(stateDir, toolName, inputPreview, error, retryCount);

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
