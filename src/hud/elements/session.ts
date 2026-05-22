/**
 * OMC HUD - Session Health Element
 *
 * Renders session duration and health indicator.
 */

import type { SessionHealth } from '../types.js';
import { green, red, yellow } from '../colors.js';

/**
 * Format a duration in minutes as a compact, human-readable string.
 *
 * Auto-scales to the largest natural unit so long-running sessions don't
 * render as e.g. "4755m" (~3 days) — which is hard to read at a glance.
 *
 *   42        -> "42m"
 *   90        -> "1h"
 *   1500      -> "1d1h"
 *   4755      -> "3d7h"
 *   2880      -> "2d"   (exact-day boundaries drop the trailing 0h)
 */
export function formatSessionDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d${remHours}h` : `${days}d`;
}

/**
 * Render session health indicator.
 *
 * Format: session:45m / session:2h / session:3d7h
 */
export function renderSession(session: SessionHealth | null): string | null {
  if (!session) return null;

  const colorize = session.health === 'critical' ? red
    : session.health === 'warning' ? yellow
    : green;

  return `session:${colorize(formatSessionDuration(session.durationMinutes))}`;
}
