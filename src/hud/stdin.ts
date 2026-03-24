/**
 * OMC HUD - Stdin Parser
 *
 * Parse stdin JSON from Claude Code statusline interface.
 * Based on claude-hud reference implementation.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getWorktreeRoot } from '../lib/worktree-paths.js';
import type { StatuslineStdin } from './types.js';

const TRANSIENT_CONTEXT_PERCENT_TOLERANCE = 3;

// ============================================================================
// Stdin Cache (for --watch mode)
// ============================================================================

function getStdinCachePath(): string {
  const root = getWorktreeRoot() || process.cwd();
  return join(root, '.omc', 'state', 'hud-stdin-cache.json');
}

/**
 * Persist the last successful stdin read to disk.
 * Used by --watch mode to recover data when stdin is a TTY.
 */
export function writeStdinCache(stdin: StatuslineStdin): void {
  try {
    const root = getWorktreeRoot() || process.cwd();
    const cacheDir = join(root, '.omc', 'state');
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
    writeFileSync(getStdinCachePath(), JSON.stringify(stdin));
  } catch {
    // Best-effort; ignore failures
  }
}

/**
 * Read the last cached stdin JSON.
 * Returns null if no cache exists or it is unreadable.
 */
export function readStdinCache(): StatuslineStdin | null {
  try {
    const cachePath = getStdinCachePath();
    if (!existsSync(cachePath)) {
      return null;
    }
    return JSON.parse(readFileSync(cachePath, 'utf-8')) as StatuslineStdin;
  } catch {
    return null;
  }
}

// ============================================================================
// Stdin Reader
// ============================================================================

/**
 * Read and parse stdin JSON from Claude Code.
 * Returns null if stdin is not available or invalid.
 */
export async function readStdin(): Promise<StatuslineStdin | null> {
  // Skip if running in TTY mode (interactive terminal)
  if (process.stdin.isTTY) {
    return null;
  }

  const chunks: string[] = [];

  try {
    process.stdin.setEncoding('utf8');

    for await (const chunk of process.stdin) {
      chunks.push(chunk as string);
    }

    const raw = chunks.join('');
    if (!raw.trim()) {
      return null;
    }

    return JSON.parse(raw) as StatuslineStdin;
  } catch {
    return null;
  }
}

function getCurrentUsage(stdin: StatuslineStdin) {
  return stdin.context_window?.current_usage;
}

/**
 * Get total tokens from stdin context_window.current_usage
 */
function getTotalTokens(stdin: StatuslineStdin): number {
  const usage = getCurrentUsage(stdin);
  return (
    (usage?.input_tokens ?? 0) +
    (usage?.cache_creation_input_tokens ?? 0) +
    (usage?.cache_read_input_tokens ?? 0)
  );
}

function getRoundedNativeContextPercent(stdin: StatuslineStdin | null | undefined): number | null {
  const nativePercent = stdin?.context_window?.used_percentage;
  if (typeof nativePercent !== 'number' || Number.isNaN(nativePercent)) {
    return null;
  }
  return Math.min(100, Math.max(0, Math.round(nativePercent)));
}

function getManualContextPercent(stdin: StatuslineStdin): number | null {
  const size = stdin.context_window?.context_window_size;
  if (!size || size <= 0) {
    return null;
  }

  const totalTokens = getTotalTokens(stdin);
  return Math.min(100, Math.round((totalTokens / size) * 100));
}

function isSameContextStream(current: StatuslineStdin, previous: StatuslineStdin): boolean {
  return current.cwd === previous.cwd
    && current.transcript_path === previous.transcript_path
    && current.context_window?.context_window_size === previous.context_window?.context_window_size;
}

/**
 * Preserve the last native context percentage across transient snapshots where Claude Code
 * omits `used_percentage`, but only when the fallback calculation is close enough to suggest
 * the same underlying value rather than a real context jump.
 */
export function stabilizeContextPercent(
  stdin: StatuslineStdin,
  previousStdin: StatuslineStdin | null | undefined,
): StatuslineStdin {
  if (getRoundedNativeContextPercent(stdin) !== null) {
    return stdin;
  }

  if (!previousStdin || !isSameContextStream(stdin, previousStdin)) {
    return stdin;
  }

  const previousNativePercent = getRoundedNativeContextPercent(previousStdin);
  if (previousNativePercent === null) {
    return stdin;
  }

  const manualPercent = getManualContextPercent(stdin);
  if (
    manualPercent !== null
    && Math.abs(manualPercent - previousNativePercent) > TRANSIENT_CONTEXT_PERCENT_TOLERANCE
  ) {
    return stdin;
  }

  return {
    ...stdin,
    context_window: {
      ...stdin.context_window,
      used_percentage: previousStdin.context_window?.used_percentage ?? previousNativePercent,
    },
  };
}

/**
 * Get context window usage percentage.
 * Prefers native percentage from Claude Code statusline stdin, falls back to manual calculation.
 */
export function getContextPercent(stdin: StatuslineStdin): number {
  const nativePercent = getRoundedNativeContextPercent(stdin);
  if (nativePercent !== null) {
    return nativePercent;
  }

  return getManualContextPercent(stdin) ?? 0;
}

/**
 * Get model display name from stdin.
 * Prefer the official display name field, then fall back to the raw model id.
 */
export function getModelName(stdin: StatuslineStdin): string {
  return stdin.model?.display_name ?? stdin.model?.id ?? 'Unknown';
}
