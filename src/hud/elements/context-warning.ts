/**
 * OMC HUD - Context Limit Warning Element
 *
 * Renders a prominent warning banner when context usage exceeds the configured
 * threshold. Supports an autoCompact mode that signals a queued compact request.
 */

import { RESET } from '../colors.js';

const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';

/**
 * Render a context limit warning banner.
 *
 * Returns a warning string when contextPercent >= threshold, null otherwise.
 *
 * @param contextPercent - Current context usage (0-100)
 * @param threshold - Configured threshold to trigger warning (default 80)
 * @param autoCompact - Whether autoCompact is enabled (affects queued/requested copy)
 */
export function renderContextLimitWarning(
  contextPercent: number,
  threshold: number,
  autoCompact: boolean
): string | null {
  const safePercent = Math.min(100, Math.max(0, Math.round(contextPercent)));

  if (safePercent < threshold) {
    return null;
  }

  const isCritical = safePercent >= 90;
  const color = isCritical ? RED : YELLOW;
  const icon = isCritical ? '!!' : '!';
  const action = autoCompact ? 'compact request queued' : 'run /compact';

  return `${color}${BOLD}[${icon}] ctx ${safePercent}% >= ${threshold}% threshold - ${action}${RESET}`;
}
