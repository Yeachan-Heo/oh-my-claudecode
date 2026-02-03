/**
 * OMC HUD - Output Sanitizer
 *
 * Sanitizes HUD output to prevent terminal rendering corruption
 * when Claude Code's Ink renderer is concurrently updating the display.
 *
 * Issue #346: Terminal rendering corruption during AI generation with HUD enabled.
 *
 * Root cause: Multi-line output containing ANSI escape sequences and
 * variable-width Unicode characters (progress bar blocks) can interfere
 * with Claude Code's terminal cursor positioning during active rendering.
 *
 * This module provides:
 * - ANSI escape sequence stripping
 * - Unicode block character replacement with ASCII equivalents
 * - Line count enforcement (collapse to single line if needed)
 */

// Matches all ANSI escape sequences: CSI (ESC[...), OSC (ESC]...), and simple (ESC + char)
const ANSI_REGEX = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[^[\]]/g;

/**
 * Strip all ANSI escape sequences from a string.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, '');
}

/**
 * Replace variable-width Unicode block characters with fixed-width ASCII equivalents.
 * Targets characters commonly used in progress bars that have inconsistent
 * terminal width across different terminal emulators.
 */
export function replaceUnicodeBlocks(text: string): string {
  return text
    .replace(/█/g, '#')
    .replace(/░/g, '-')
    .replace(/▓/g, '=')
    .replace(/▒/g, '-');
}

/**
 * Sanitize HUD output for safe terminal rendering.
 *
 * When safeMode is enabled:
 * 1. Strips all ANSI escape sequences (prevents cursor position conflicts)
 * 2. Replaces Unicode block characters with ASCII (prevents width miscalculation)
 * 3. Collapses multi-line output into a single pipe-separated line
 *    (prevents statusline area resize during active rendering)
 * 4. Uses regular spaces instead of non-breaking spaces
 *    (prevents width calculation mismatches in some terminals)
 *
 * @param output - Raw HUD output (may contain ANSI codes and newlines)
 * @returns Sanitized output safe for concurrent terminal rendering
 */
export function sanitizeOutput(output: string): string {
  // Step 1: Strip ANSI escape sequences
  let sanitized = stripAnsi(output);

  // Step 2: Replace variable-width Unicode with ASCII
  sanitized = replaceUnicodeBlocks(sanitized);

  // Step 3: Collapse multi-line output to single line
  // Split on newlines, filter empty lines, join with pipe separator
  const lines = sanitized.split('\n').filter(line => line.trim().length > 0);
  if (lines.length > 1) {
    sanitized = lines.join(' | ');
  } else {
    sanitized = lines[0] || '';
  }

  // Step 4: Trim excessive whitespace
  sanitized = sanitized.replace(/\s{2,}/g, ' ').trim();

  return sanitized;
}
