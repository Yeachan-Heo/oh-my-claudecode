/**
 * OMC HUD - ANSI Color Utilities
 *
 * Terminal color codes for statusline rendering.
 * Based on claude-hud reference implementation.
 * Extended with gradient colors and icon constants.
 */

// ============================================================================
// Basic ANSI Escape Codes
// ============================================================================

export const RESET = '\x1b[0m';
export const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const ITALIC = '\x1b[3m';
const UNDERLINE = '\x1b[4m';

// Standard colors (0-7) - exported for direct use in elements
export const BLACK = '\x1b[30m';
export const RED = '\x1b[31m';
export const GREEN = '\x1b[32m';
export const YELLOW = '\x1b[33m';
export const BLUE = '\x1b[34m';
export const MAGENTA = '\x1b[35m';
export const CYAN = '\x1b[36m';
export const WHITE = '\x1b[37m';

// Bright colors (8-15)
const BRIGHT_BLACK = '\x1b[90m';
export const BRIGHT_RED = '\x1b[91m';
export const BRIGHT_GREEN = '\x1b[92m';
export const BRIGHT_YELLOW = '\x1b[93m';
export const BRIGHT_BLUE = '\x1b[94m';
export const BRIGHT_MAGENTA = '\x1b[95m';
export const BRIGHT_CYAN = '\x1b[96m';
export const BRIGHT_WHITE = '\x1b[97m';

// 256-color palette (useful for gradients)
export const ORANGE = '\x1b[38;5;208m';
export const DEEP_ORANGE = '\x1b[38;5;202m';
export const LIGHT_GREEN = '\x1b[38;5;119m';
export const TEAL = '\x1b[38;5;37m';
export const PURPLE = '\x1b[38;5;99m';
export const GOLD = '\x1b[38;5;220m';

// ============================================================================
// Color Functions
// ============================================================================

export function green(text: string): string {
  return `${GREEN}${text}${RESET}`;
}

export function yellow(text: string): string {
  return `${YELLOW}${text}${RESET}`;
}

export function red(text: string): string {
  return `${RED}${text}${RESET}`;
}

export function cyan(text: string): string {
  return `${CYAN}${text}${RESET}`;
}

export function magenta(text: string): string {
  return `${MAGENTA}${text}${RESET}`;
}

export function blue(text: string): string {
  return `${BLUE}${text}${RESET}`;
}

export function dim(text: string): string {
  return `${DIM}${text}${RESET}`;
}

export function bold(text: string): string {
  return `${BOLD}${text}${RESET}`;
}

export function white(text: string): string {
  return `${WHITE}${text}${RESET}`;
}

export function brightCyan(text: string): string {
  return `${BRIGHT_CYAN}${text}${RESET}`;
}

export function brightMagenta(text: string): string {
  return `${BRIGHT_MAGENTA}${text}${RESET}`;
}

export function brightBlue(text: string): string {
  return `${BRIGHT_BLUE}${text}${RESET}`;
}

// ============================================================================
// Threshold-based Colors
// ============================================================================

/**
 * Get color code based on context window percentage.
 */
export function getContextColor(percent: number): string {
  if (percent >= 85) return RED;
  if (percent >= 70) return YELLOW;
  return GREEN;
}

/**
 * Get color code based on ralph iteration.
 */
export function getRalphColor(iteration: number, maxIterations: number): string {
  const warningThreshold = Math.floor(maxIterations * 0.7);
  const criticalThreshold = Math.floor(maxIterations * 0.9);

  if (iteration >= criticalThreshold) return RED;
  if (iteration >= warningThreshold) return YELLOW;
  return GREEN;
}

/**
 * Get color for todo progress.
 */
export function getTodoColor(completed: number, total: number): string {
  if (total === 0) return DIM;
  const percent = (completed / total) * 100;
  if (percent >= 80) return GREEN;
  if (percent >= 50) return YELLOW;
  return CYAN;
}

// ============================================================================
// Model Tier Colors (for agent visualization)
// ============================================================================

/**
 * Get color for model tier.
 * - Opus: Magenta (high-powered)
 * - Sonnet: Yellow (standard)
 * - Haiku: Green (lightweight)
 */
export function getModelTierColor(model: string | undefined): string {
  if (!model) return CYAN; // Default/unknown
  const tier = model.toLowerCase();
  if (tier.includes('opus')) return MAGENTA;
  if (tier.includes('sonnet')) return YELLOW;
  if (tier.includes('haiku')) return GREEN;
  return CYAN; // Unknown model
}

/**
 * Get color for agent duration (warning/alert).
 * - <2min: normal (green)
 * - 2-5min: warning (yellow)
 * - >5min: alert (red)
 */
export function getDurationColor(durationMs: number): string {
  const minutes = durationMs / 60000;
  if (minutes >= 5) return RED;
  if (minutes >= 2) return YELLOW;
  return GREEN;
}

// ============================================================================
// Progress Bars
// ============================================================================

/**
 * Create a colored progress bar.
 */
export function coloredBar(percent: number, width: number = 10): string {
  const safeWidth = Number.isFinite(width) ? Math.max(0, Math.round(width)) : 0;
  const safePercent = Number.isFinite(percent)
    ? Math.min(100, Math.max(0, percent))
    : 0;

  const filled = Math.round((safePercent / 100) * safeWidth);
  const empty = safeWidth - filled;

  const color = getContextColor(safePercent);
  return `${color}${'█'.repeat(filled)}${DIM}${'░'.repeat(empty)}${RESET}`;
}

/**
 * Create a simple numeric display with color.
 */
export function coloredValue(
  value: number,
  total: number,
  getColor: (value: number, total: number) => string
): string {
  const color = getColor(value, total);
  return `${color}${value}/${total}${RESET}`;
}

// ============================================================================
// Gradient Colors
// ============================================================================

/**
 * Get a smooth gradient color based on percentage.
 * Uses 256-color palette for better transitions.
 * 
 * Color progression:
 * - 0-30%: Green (healthy)
 * - 30-50%: Teal/Green transition
 * - 50-70%: Yellow (warning)
 * - 70-85%: Orange (alert)
 * - 85-95%: Red (critical)
 * - 95-100%: Bright Red (severe)
 */
export function getGradientColor(percent: number): string {
  const safePercent = Math.min(100, Math.max(0, percent));

  // Use 256-color palette for smooth transitions
  if (safePercent < 30) {
    return GREEN;          // 32 - Green
  } else if (safePercent < 50) {
    return LIGHT_GREEN;    // 119 - Light Green
  } else if (safePercent < 60) {
    return YELLOW;         // 33 - Yellow
  } else if (safePercent < 70) {
    return GOLD;           // 220 - Gold
  } else if (safePercent < 80) {
    return ORANGE;         // 208 - Orange
  } else if (safePercent < 90) {
    return DEEP_ORANGE;    // 202 - Deep Orange
  } else if (safePercent < 95) {
    return RED;            // 31 - Red
  } else {
    return BRIGHT_RED;     // 91 - Bright Red
  }
}

/**
 * Get gradient color for rate limits.
 * Uses standard thresholds but with smoother transitions.
 */
export function getRateLimitGradientColor(percent: number): string {
  const safePercent = Math.min(100, Math.max(0, percent));

  if (safePercent < 50) {
    return GREEN;
  } else if (safePercent < 70) {
    return LIGHT_GREEN;
  } else if (safePercent < 80) {
    return YELLOW;
  } else if (safePercent < 90) {
    return ORANGE;
  } else {
    return RED;
  }
}

/**
 * Get gradient color for session duration.
 * Longer sessions get warmer colors.
 */
export function getSessionDurationColor(durationMinutes: number): string {
  if (durationMinutes < 15) {
    return GREEN;           // Fresh session
  } else if (durationMinutes < 30) {
    return LIGHT_GREEN;     // Active
  } else if (durationMinutes < 60) {
    return YELLOW;          // Moderate
  } else if (durationMinutes < 120) {
    return ORANGE;          // Long session
  } else {
    return RED;             // Very long session
  }
}

// ============================================================================
// Icons and Symbols
// ============================================================================

/**
 * UI Icons for different elements.
 * All icons have ASCII fallbacks for terminals without Unicode support.
 */
export const ICONS = {
  // Status indicators
  check: '✓',
  cross: '✗',
  warning: '⚠',
  info: 'ℹ',
  
  // Health indicators (dots)
  healthy: '●',
  warningDot: '●',  // Renamed to avoid duplicate key
  critical: '●',
  
  // Progress indicators
  progress: '◈',
  loading: '⋯',
  
  // Agent types (symbolic)
  architect: '◇',      // Diamond - structure
  executor: '▶',       // Arrow - action
  explorer: '◈',       // Diamond variant - search
  debugger: '⚡',      // Lightning - fix
  reviewer: '✓',       // Check - verify
  planner: '◐',        // Circle - plan
  tester: '◎',         // Target - test
  
  // Branch/Version control
  branch: '',
  commit: '◆',
  
  // Thinking
  thinking: '◈',
  brain: '🧠',
  
  // Activity
  running: '▶',
  pending: '○',
  completed: '●',
  
  // Separator
  separator: '│',
  branchSeparator: '├',
  endSeparator: '└',
  line: '─',
  
  // Directional
  arrow: '→',
  arrowRight: '▸',
  arrowRightHollow: '▹',
} as const;

/**
 * ASCII fallbacks for icons.
 */
export const ASCII_ICONS = {
  check: '[OK]',
  cross: '[X]',
  warning: '[!]',
  info: '[i]',
  
  healthy: '*',
  warningDot: '!',  // Renamed to avoid duplicate key
  critical: '!',
  
  progress: '*',
  loading: '...',
  
  architect: 'A',
  executor: '>',
  explorer: 'e',
  debugger: '!',
  reviewer: 'R',
  planner: 'P',
  tester: 'T',
  
  branch: '',
  commit: '*',
  
  thinking: '*',
  brain: '(thinking)',
  
  running: '>',
  pending: 'o',
  completed: '*',
  
  separator: '|',
  branchSeparator: '|--',
  endSeparator: '`--',
  line: '-',
  
  arrow: '->',
  arrowRight: '>',
  arrowRightHollow: '-',
} as const;

/**
 * Get icon for agent type.
 */
export function getAgentIcon(agentType: string, useAscii: boolean = false): string {
  const icons = useAscii ? ASCII_ICONS : ICONS;
  
  // Normalize agent type
  const type = agentType.split(':').pop()?.toLowerCase() || agentType.toLowerCase();
  
  switch (type) {
    case 'architect':
      return icons.architect;
    case 'executor':
    case 'exec':
      return icons.executor;
    case 'explore':
    case 'explorer':
      return icons.explorer;
    case 'debugger':
    case 'debug':
      return icons.debugger;
    case 'reviewer':
    case 'code-reviewer':
      return icons.reviewer;
    case 'planner':
      return icons.planner;
    case 'tester':
    case 'qa-tester':
      return icons.tester;
    default:
      return useAscii ? type.charAt(0).toUpperCase() : '◈';
  }
}

/**
 * Get health indicator icon.
 */
export function getHealthIcon(health: 'healthy' | 'warning' | 'critical', useAscii: boolean = false): string {
  const icons = useAscii ? ASCII_ICONS : ICONS;
  
  switch (health) {
    case 'healthy':
      return icons.healthy;
    case 'warning':
      return icons.warning;
    case 'critical':
      return icons.critical;
  }
}

// ============================================================================
// Additional Color Functions
// ============================================================================

/**
 * Orange text (for warnings that aren't critical).
 */
export function orange(text: string): string {
  return `${ORANGE}${text}${RESET}`;
}

/**
 * Gold text (for highlights).
 */
export function gold(text: string): string {
  return `${GOLD}${text}${RESET}`;
}

/**
 * Bright red text (for severe warnings).
 */
export function brightRed(text: string): string {
  return `${BRIGHT_RED}${text}${RESET}`;
}

/**
 * Teal text.
 */
export function teal(text: string): string {
  return `${TEAL}${text}${RESET}`;
}

/**
 * Purple text.
 */
export function purple(text: string): string {
  return `${PURPLE}${text}${RESET}`;
}

/**
 * Apply italic styling.
 */
export function italic(text: string): string {
  return `${ITALIC}${text}${RESET}`;
}

/**
 * Apply underline styling.
 */
export function underline(text: string): string {
  return `${UNDERLINE}${text}${RESET}`;
}

/**
 * Create a dim separator string.
 */
export function separator(text: string = ' | '): string {
  return `${DIM}${text}${RESET}`;
}

/**
 * Create a horizontal line.
 */
export function horizontalLine(width: number = 40): string {
  return `${DIM}${ICONS.line.repeat(width)}${RESET}`;
}
