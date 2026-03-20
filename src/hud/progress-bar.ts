/**
 * OMC HUD - Progress Bar Component
 *
 * Configurable progress bar with multiple visual styles.
 * Supports color gradients and automatic threshold coloring.
 */

import type { ProgressBarStyle } from './terminal-capabilities.js';
import { RESET, getContextColor } from './colors.js';

// ============================================================================
// Constants
// ============================================================================

/** Character sets for different progress bar styles */
const PROGRESS_CHARS = {
  solid: {
    filled: '█',
    empty: '░',
  },
  blocks: {
    filled: '▓',
    empty: '░',
  },
  dots: {
    filled: '●',
    empty: '○',
  },
  minimal: {
    filled: '▸',
    empty: '▹',
  },
  ascii: {
    filled: '=',
    empty: '.',
  },
};

// ANSI color codes
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';
const ORANGE = '\x1b[38;5;208m';  // 256-color orange
const BRIGHT_RED = '\x1b[91m';     // Bright red

// ============================================================================
// Types
// ============================================================================

/**
 * Options for progress bar rendering.
 */
export interface ProgressBarOptions {
  /** Progress percentage (0-100) */
  percent: number;

  /** Bar width in characters (default: 10) */
  width?: number;

  /** Visual style (default: 'solid') */
  style?: ProgressBarStyle;

  /** Whether to show percentage label (default: true) */
  showPercent?: boolean;

  /** Custom color function (overrides default threshold colors) */
  colorFn?: (percent: number) => string;

  /** Whether to apply gradient coloring (default: false) */
  useGradient?: boolean;

  /** Threshold for warning color (default: 70) */
  warningThreshold?: number;

  /** Threshold for critical color (default: 85) */
  criticalThreshold?: number;
}

/**
 * Result of progress bar rendering.
 */
export interface ProgressBarResult {
  /** The rendered progress bar string */
  bar: string;

  /** The color used */
  color: string;

  /** Whether the percentage is in warning range */
  isWarning: boolean;

  /** Whether the percentage is in critical range */
  isCritical: boolean;
}

// ============================================================================
// Color Functions
// ============================================================================

/**
 * Get color based on percentage with gradient support.
 * Provides smoother color transitions than simple thresholds.
 */
export function getGradientColor(percent: number): string {
  const safePercent = Math.min(100, Math.max(0, percent));

  // 0-50%: Green to Cyan gradient
  if (safePercent < 50) {
    return GREEN;
  }

  // 50-70%: Yellow
  if (safePercent < 70) {
    return YELLOW;
  }

  // 70-85%: Orange (warning)
  if (safePercent < 85) {
    return ORANGE;
  }

  // 85-100%: Red to Bright Red
  if (safePercent < 95) {
    return RED;
  }

  return BRIGHT_RED;
}

/**
 * Get color for todo progress (different thresholds).
 */
export function getTodoProgressColor(completed: number, total: number): string {
  if (total === 0) return DIM;
  const percent = (completed / total) * 100;

  if (percent >= 100) return GREEN;     // Complete
  if (percent >= 80) return CYAN;       // Almost done
  if (percent >= 50) return YELLOW;     // Halfway
  return MAGENTA;                        // Started
}

/**
 * Get color for rate limits (standard thresholds).
 */
export function getRateLimitColor(percent: number): string {
  if (percent >= 90) return RED;
  if (percent >= 70) return YELLOW;
  return GREEN;
}

// ============================================================================
// Progress Bar Rendering
// ============================================================================

/**
 * Render a progress bar with the specified options.
 */
export function renderProgressBar(options: ProgressBarOptions): ProgressBarResult {
  const {
    percent,
    width = 10,
    style = 'solid',
    showPercent = true,
    useGradient = false,
    warningThreshold = 70,
    criticalThreshold = 85,
  } = options;

  const safeWidth = Math.max(1, Math.round(width));
  const safePercent = Math.min(100, Math.max(0, percent));

  const filled = Math.round((safePercent / 100) * safeWidth);
  const empty = safeWidth - filled;

  // Determine color
  const colorFn = options.colorFn || (useGradient ? getGradientColor : getContextColor);
  const color = colorFn(safePercent);

  // Determine status
  const isWarning = safePercent >= warningThreshold && safePercent < criticalThreshold;
  const isCritical = safePercent >= criticalThreshold;

  // Get character set for style
  const chars = PROGRESS_CHARS[style] || PROGRESS_CHARS.solid;

  // Build the bar
  const filledPart = `${color}${chars.filled.repeat(filled)}`;
  const emptyPart = `${DIM}${chars.empty.repeat(empty)}${RESET}`;

  let bar = `${filledPart}${emptyPart}`;

  // Add percentage label
  if (showPercent) {
    bar = `[${bar}]${color}${safePercent}%${RESET}`;
  } else {
    bar = `[${bar}]`;
  }

  return {
    bar,
    color,
    isWarning,
    isCritical,
  };
}

/**
 * Render a simple progress bar (convenience function).
 */
export function renderSimpleProgressBar(
  percent: number,
  width: number = 10,
  style: ProgressBarStyle = 'solid'
): string {
  const result = renderProgressBar({ percent, width, style, showPercent: false });
  return result.bar;
}

/**
 * Render a progress bar with percentage label.
 */
export function renderProgressBarWithPercent(
  percent: number,
  width: number = 10,
  style: ProgressBarStyle = 'solid'
): string {
  const result = renderProgressBar({ percent, width, style, showPercent: true });
  return result.bar;
}

// ============================================================================
// Specialized Progress Bars
// ============================================================================

/**
 * Render context window progress bar.
 * Uses context-specific thresholds and styling.
 */
export function renderContextProgressBar(
  percent: number,
  width: number = 10,
  style: ProgressBarStyle = 'solid'
): string {
  const result = renderProgressBar({
    percent,
    width,
    style,
    showPercent: true,
    useGradient: true,
    warningThreshold: 70,
    criticalThreshold: 85,
  });

  let output = result.bar;

  // Add status suffix
  if (result.isCritical) {
    output += ' CRITICAL';
  } else if (result.isWarning) {
    output += ' COMPRESS?';
  }

  return output;
}

/**
 * Render rate limit progress bar.
 * Uses rate-limit-specific thresholds.
 */
export function renderRateLimitProgressBar(
  percent: number,
  width: number = 8,
  style: ProgressBarStyle = 'solid'
): string {
  return renderProgressBar({
    percent,
    width,
    style,
    showPercent: true,
    colorFn: getRateLimitColor,
  }).bar;
}

/**
 * Render todo progress bar.
 */
export function renderTodoProgressBar(
  completed: number,
  total: number,
  width: number = 10,
  style: ProgressBarStyle = 'solid'
): string {
  if (total === 0) {
    return `${DIM}[${' '.repeat(width)}]${RESET}`;
  }

  const percent = (completed / total) * 100;

  return renderProgressBar({
    percent,
    width,
    style,
    showPercent: false,
    colorFn: () => getTodoProgressColor(completed, total),
  }).bar;
}

// ============================================================================
// Mini Indicators
// ============================================================================

/**
 * Render a mini progress indicator (3 chars max).
 */
export function renderMiniProgress(percent: number): string {
  const safePercent = Math.min(100, Math.max(0, percent));

  if (safePercent >= 90) {
    return `${RED}▓▓▓${RESET}`;
  }
  if (safePercent >= 70) {
    return `${YELLOW}▓▓░${RESET}`;
  }
  if (safePercent >= 50) {
    return `${CYAN}▓░░${RESET}`;
  }
  if (safePercent >= 25) {
    return `${GREEN}░░░${RESET}`;
  }
  return `${DIM}░░░${RESET}`;
}

/**
 * Render a health indicator dot.
 */
export function renderHealthIndicator(health: 'healthy' | 'warning' | 'critical'): string {
  switch (health) {
    case 'healthy':
      return `${GREEN}●${RESET}`;
    case 'warning':
      return `${YELLOW}●${RESET}`;
    case 'critical':
      return `${RED}●${RESET}`;
  }
}

/**
 * Render a status checkmark or cross.
 */
export function renderStatusIndicator(success: boolean): string {
  return success ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
}