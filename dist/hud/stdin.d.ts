/**
 * OMC HUD - Stdin Parser
 *
 * Parse stdin JSON from Claude Code statusline interface.
 * Based on claude-hud reference implementation.
 */
import type { StatuslineStdin } from './types.js';
/**
 * Persist the last successful stdin read to disk.
 * Used by --watch mode to recover data when stdin is a TTY.
 */
export declare function writeStdinCache(stdin: StatuslineStdin): void;
/**
 * Read the last cached stdin JSON.
 * Returns null if no cache exists or it is unreadable.
 */
export declare function readStdinCache(): StatuslineStdin | null;
/**
 * Read and parse stdin JSON from Claude Code.
 * Returns null if stdin is not available or invalid.
 */
export declare function readStdin(): Promise<StatuslineStdin | null>;
/**
 * Preserve the last native context percentage across transient snapshots where Claude Code
 * omits `used_percentage`, but only when the fallback calculation is close enough to suggest
 * the same underlying value rather than a real context jump.
 */
export declare function stabilizeContextPercent(stdin: StatuslineStdin, previousStdin: StatuslineStdin | null | undefined): StatuslineStdin;
/**
 * Get context window usage percentage.
 * Prefers native percentage from Claude Code statusline stdin, falls back to manual calculation.
 */
export declare function getContextPercent(stdin: StatuslineStdin): number;
/**
 * Get model display name from stdin.
 * Prefer the official display name field, then fall back to the raw model id.
 */
export declare function getModelName(stdin: StatuslineStdin): string;
//# sourceMappingURL=stdin.d.ts.map