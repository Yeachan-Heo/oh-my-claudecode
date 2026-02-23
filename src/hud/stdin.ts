/**
 * OMC HUD - Stdin Parser
 *
 * Parse stdin JSON from Claude Code statusline interface.
 * Based on claude-hud reference implementation.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { StatuslineStdin } from './types.js';

// ============================================================================
// Stdin Cache (for --watch mode)
// ============================================================================

function getStdinCachePath(): string {
  return join(process.cwd(), '.omc', 'state', 'hud-stdin-cache.json');
}

/**
 * Persist the last successful stdin read to disk.
 * Used by --watch mode to recover data when stdin is a TTY.
 */
export function writeStdinCache(stdin: StatuslineStdin): void {
  try {
    const cacheDir = join(process.cwd(), '.omc', 'state');
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

/**
 * Get total tokens from stdin context_window.current_usage
 */
function getTotalTokens(stdin: StatuslineStdin): number {
  const usage = stdin.context_window?.current_usage;
  return (
    (usage?.input_tokens ?? 0) +
    (usage?.cache_creation_input_tokens ?? 0) +
    (usage?.cache_read_input_tokens ?? 0)
  );
}

/**
 * Get context window usage percentage.
 * Prefers native percentage from Claude Code v2.1.6+, falls back to manual calculation.
 */
export function getContextPercent(stdin: StatuslineStdin): number {
  // Prefer native percentage (v2.1.6+) - accurate and matches /context
  const nativePercent = stdin.context_window?.used_percentage;
  if (typeof nativePercent === 'number' && !Number.isNaN(nativePercent)) {
    return Math.min(100, Math.max(0, Math.round(nativePercent)));
  }

  // Fallback: manual calculation
  const size = stdin.context_window?.context_window_size;
  if (!size || size <= 0) {
    return 0;
  }

  const totalTokens = getTotalTokens(stdin);
  return Math.min(100, Math.round((totalTokens / size) * 100));
}

/**
 * Get model display name from stdin.
 */
export function getModelName(stdin: StatuslineStdin): string {
  return stdin.model?.id ?? stdin.model?.display_name ?? 'Unknown';
}
