/**
 * OMC HUD - Effort Level Element
 *
 * Renders the Claude Code effort level reported in statusline stdin.
 */

import { cyan, dim, yellow } from '../colors.js';

/**
 * Render effort level, colored by intensity: low is dim, high and above are yellow.
 *
 * @returns "effort:<level>" label, or null when stdin has no effort level
 */
export function renderEffort(level: string | null | undefined): string | null {
  if (!level) return null;
  const label = `effort:${level}`;
  switch (level) {
    case 'low':
      return dim(label);
    case 'high':
    case 'xhigh':
    case 'max':
      return yellow(label);
    default:
      return cyan(label);
  }
}
