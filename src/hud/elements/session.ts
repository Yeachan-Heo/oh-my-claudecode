/**
 * OMC HUD - Session Health Element
 *
 * Renders session duration and health indicator with visual indicators.
 * Enhanced with health lights and message count.
 */

import type { SessionHealth } from '../types.js';
import { RESET, DIM, GREEN, YELLOW, RED, CYAN, BRIGHT_CYAN, ICONS, ASCII_ICONS, getSessionDurationColor } from '../colors.js';
import { renderHealthIndicator } from '../progress-bar.js';

/**
 * Format duration for human-readable display.
 */
function formatDuration(minutes: number): string {
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (hours < 24) {
    return remainingMinutes > 0 ? `${hours}h${remainingMinutes}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;

  return remainingHours > 0 ? `${days}d${remainingHours}h` : `${days}d`;
}

/**
 * Get color based on session health status.
 */
function getHealthColor(health: 'healthy' | 'warning' | 'critical'): string {
  switch (health) {
    case 'healthy':
      return GREEN;
    case 'warning':
      return YELLOW;
    case 'critical':
      return RED;
  }
}

/**
 * Render session health indicator.
 *
 * Format: session:45m or session:45m (healthy)
 */
export function renderSession(session: SessionHealth | null): string | null {
  if (!session) return null;

  const color = getHealthColor(session.health);
  const duration = formatDuration(session.durationMinutes);

  return `session:${color}${duration}${RESET}`;
}

/**
 * Render session with health indicator light.
 *
 * Format: session:45m ● or session:45m 🟢
 *
 * @param session - Session health data
 * @param useAscii - Whether to use ASCII fallback for indicators
 */
export function renderSessionWithHealth(
  session: SessionHealth | null,
  useAscii: boolean = false
): string | null {
  if (!session) return null;

  const color = getHealthColor(session.health);
  const duration = formatDuration(session.durationMinutes);
  const indicator = renderHealthIndicator(session.health);

  return `session:${color}${duration}${RESET} ${indicator}`;
}

/**
 * Render session with emoji health indicator.
 *
 * Format: session:45m 🟢 or session:45m 🟡 or session:45m 🔴
 */
export function renderSessionWithEmoji(session: SessionHealth | null): string | null {
  if (!session) return null;

  const color = getHealthColor(session.health);
  const duration = formatDuration(session.durationMinutes);

  let emoji: string;
  switch (session.health) {
    case 'healthy':
      emoji = '🟢';
      break;
    case 'warning':
      emoji = '🟡';
      break;
    case 'critical':
      emoji = '🔴';
      break;
  }

  return `session:${color}${duration}${RESET} ${emoji}`;
}

/**
 * Render session with message count.
 *
 * Format: session:45m (12 msgs)
 */
export function renderSessionWithMessages(session: SessionHealth | null): string | null {
  if (!session) return null;

  const color = getHealthColor(session.health);
  const duration = formatDuration(session.durationMinutes);

  return `session:${color}${duration}${RESET} ${DIM}(${session.messageCount} msgs)${RESET}`;
}

/**
 * Render full session display with health and messages.
 *
 * Format: session:45m ● (12 msgs)
 *
 * @param session - Session health data
 * @param useAscii - Whether to use ASCII fallback
 */
export function renderSessionFull(
  session: SessionHealth | null,
  useAscii: boolean = false
): string | null {
  if (!session) return null;

  const color = getHealthColor(session.health);
  const duration = formatDuration(session.durationMinutes);
  const indicator = renderHealthIndicator(session.health);

  return `session:${color}${duration}${RESET} ${indicator} ${DIM}(${session.messageCount} msgs)${RESET}`;
}

/**
 * Render compact session indicator.
 *
 * Format: 45m ●
 */
export function renderSessionCompact(
  session: SessionHealth | null,
  useAscii: boolean = false
): string | null {
  if (!session) return null;

  const color = getHealthColor(session.health);
  const duration = formatDuration(session.durationMinutes);
  const indicator = renderHealthIndicator(session.health);

  return `${color}${duration}${RESET} ${indicator}`;
}

/**
 * Render session with duration-based color gradient.
 * Longer sessions get warmer colors.
 *
 * Format: session:45m
 */
export function renderSessionWithGradient(session: SessionHealth | null): string | null {
  if (!session) return null;

  // Use duration-based color
  const color = getSessionDurationColor(session.durationMinutes);
  const duration = formatDuration(session.durationMinutes);

  return `session:${color}${duration}${RESET}`;
}

/**
 * Render mini session indicator (just health light).
 *
 * Format: ● or 🟢
 */
export function renderSessionMini(session: SessionHealth | null): string | null {
  if (!session) return null;

  return renderHealthIndicator(session.health);
}