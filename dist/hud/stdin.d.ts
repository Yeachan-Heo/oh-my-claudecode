/**
 * OMC HUD - Stdin Parser
 *
 * Parse stdin JSON from Claude Code statusline interface.
 * Based on claude-hud reference implementation.
 */
import type { StatuslineStdin } from './types.js';
/**
 * Read and parse stdin JSON from Claude Code.
 * Returns null if stdin is not available or invalid.
 */
export declare function readStdin(): Promise<StatuslineStdin | null>;
/**
 * Get context window usage percentage.
 * Prefers native percentage from Claude Code v2.1.6+, falls back to manual calculation.
 */
export declare function getContextPercent(stdin: StatuslineStdin): number;
/**
 * Get model display name from stdin.
 */
export declare function getModelName(stdin: StatuslineStdin): string;
//# sourceMappingURL=stdin.d.ts.map