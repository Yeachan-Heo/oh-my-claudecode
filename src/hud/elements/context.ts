/**
 * OMC HUD - Context Element
 *
 * Renders context window usage display with configurable progress bars.
 */

import type { HudThresholds, ProgressBarStyle } from '../types.js';
import { RESET, getGradientColor } from '../colors.js';
import { renderProgressBar, getGradientColor as progressBarGradientColor } from '../progress-bar.js';

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';

/**
 * Get context color based on percentage.
 * Supports both standard threshold colors and gradient colors.
 */
function getContextColorInternal(percent: number, useGradient: boolean = false): string {
  if (useGradient) {
    return getGradientColor(percent);
  }

  if (percent >= 85) return RED;
  if (percent >= 70) return YELLOW;
  return GREEN;
}

/**
 * Render context window percentage.
 *
 * Format: ctx:67%
 */
export function renderContext(
  percent: number,
  thresholds: HudThresholds
): string | null {
  const safePercent = Math.min(100, Math.max(0, Math.round(percent)));
  let color: string;
  let suffix = '';

  if (safePercent >= thresholds.contextCritical) {
    color = RED;
    suffix = ' CRITICAL';
  } else if (safePercent >= thresholds.contextCompactSuggestion) {
    color = YELLOW;
    suffix = ' COMPRESS?';
  } else if (safePercent >= thresholds.contextWarning) {
    color = YELLOW;
  } else {
    color = GREEN;
  }

  return `ctx:${color}${safePercent}%${suffix}${RESET}`;
}

/**
 * Render context window with visual bar using the new progress bar component.
 *
 * Format: ctx:[████░░░░░░]67%
 *
 * @param percent - Context percentage (0-100)
 * @param thresholds - Threshold configuration
 * @param style - Progress bar visual style (default: 'solid')
 * @param useGradient - Use gradient colors instead of threshold colors
 */
export function renderContextWithBar(
  percent: number,
  thresholds: HudThresholds,
  style: ProgressBarStyle = 'solid',
  useGradient: boolean = false
): string | null {
  const safePercent = Math.min(100, Math.max(0, Math.round(percent)));

  let suffix = '';
  if (safePercent >= thresholds.contextCritical) {
    suffix = ' CRITICAL';
  } else if (safePercent >= thresholds.contextCompactSuggestion) {
    suffix = ' COMPRESS?';
  }

  // Use the new progress bar component
  const result = renderProgressBar({
    percent: safePercent,
    width: 10,
    style,
    showPercent: true,
    useGradient,
    warningThreshold: thresholds.contextWarning,
    criticalThreshold: thresholds.contextCritical,
  });

  return `ctx:${result.bar}${suffix}`;
}

/**
 * Render context with bar - legacy interface for backward compatibility.
 * Uses default style ('solid') and no gradient.
 *
 * @deprecated Use renderContextWithBar with style parameter instead
 */
export function renderContextWithBarLegacy(
  percent: number,
  thresholds: HudThresholds,
  barWidth: number = 10
): string | null {
  const safePercent = Math.min(100, Math.max(0, Math.round(percent)));
  const filled = Math.round((safePercent / 100) * barWidth);
  const empty = barWidth - filled;

  let color: string;
  let suffix = '';

  if (safePercent >= thresholds.contextCritical) {
    color = RED;
    suffix = ' CRITICAL';
  } else if (safePercent >= thresholds.contextCompactSuggestion) {
    color = YELLOW;
    suffix = ' COMPRESS?';
  } else if (safePercent >= thresholds.contextWarning) {
    color = YELLOW;
  } else {
    color = GREEN;
  }

  const bar = `${color}${'█'.repeat(filled)}${DIM}${'░'.repeat(empty)}${RESET}`;
  return `ctx:[${bar}]${color}${safePercent}%${suffix}${RESET}`;
}

/**
 * Render compact context display (just percentage with color).
 *
 * Format: ctx:67%
 */
export function renderContextCompact(
  percent: number,
  thresholds: HudThresholds,
  useGradient: boolean = false
): string | null {
  const safePercent = Math.min(100, Math.max(0, Math.round(percent)));
  const color = getContextColorInternal(safePercent, useGradient);

  return `ctx:${color}${safePercent}%${RESET}`;
}

/**
 * Render context with mini indicator (3 chars).
 *
 * Format: ctx:▓▓░
 */
export function renderContextMini(percent: number): string | null {
  const safePercent = Math.min(100, Math.max(0, percent));

  let indicator: string;
  if (safePercent >= 90) {
    indicator = `${RED}▓▓▓${RESET}`;
  } else if (safePercent >= 70) {
    indicator = `${YELLOW}▓▓░${RESET}`;
  } else if (safePercent >= 50) {
    indicator = `${GREEN}▓░░${RESET}`;
  } else {
    indicator = `${DIM}░░░${RESET}`;
  }

  return `ctx:${indicator}`;
}