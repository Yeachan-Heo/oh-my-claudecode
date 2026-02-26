/**
 * OMC HUD - Main Renderer
 *
 * Composes statusline output from render context.
 */
import type { HudRenderContext, HudConfig } from './types.js';
/**
 * Truncate a single line to a maximum visual width, preserving ANSI escape codes.
 * When the visible content exceeds maxWidth columns, it is truncated with an ellipsis.
 *
 * @param line - The line to truncate (may contain ANSI codes)
 * @param maxWidth - Maximum visual width in terminal columns
 * @returns Truncated line that fits within maxWidth visible columns
 */
export declare function truncateLineToMaxWidth(line: string, maxWidth: number): string;
/**
 * Limit output lines to prevent input field shrinkage (Issue #222).
 * Trims lines from the end while preserving the first (header) line.
 *
 * @param lines - Array of output lines
 * @param maxLines - Maximum number of lines to output (uses DEFAULT_HUD_CONFIG if not specified)
 * @returns Trimmed array of lines
 */
export declare function limitOutputLines(lines: string[], maxLines?: number): string[];
/**
 * Render the complete statusline (single or multi-line)
 */
export declare function render(context: HudRenderContext, config: HudConfig): Promise<string>;
//# sourceMappingURL=render.d.ts.map