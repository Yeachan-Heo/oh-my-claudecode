/**
 * OMC HUD - Effort Element
 *
 * Renders the current reasoning-effort level (e.g. "xhigh", "high", "auto").
 * The value comes from $CLAUDE_EFFORT, which Claude Code sets per session.
 *
 * Ported from the legacy omc-supplements.sh statusline wrapper so the badge is
 * now a first-class, configurable HUD element instead of a shell-appended suffix.
 */

import { dim, cyan, bold } from '../colors.js';

/**
 * Render the effort badge.
 *
 * @param effort - Effort level string; null/undefined/blank hides the badge.
 * @returns Formatted `effort:<level>` badge, or null when there is no value.
 */
export function renderEffort(effort: string | null | undefined): string | null {
  if (!effort) return null;
  const value = effort.trim();
  if (!value) return null;
  return `${dim('effort:')}${cyan(bold(value))}`;
}
