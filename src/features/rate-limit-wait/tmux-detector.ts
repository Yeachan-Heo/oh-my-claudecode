/**
 * tmux Detector
 *
 * Detects Claude Code sessions running in tmux panes and identifies
 * those that are blocked due to rate limiting.
 *
 * Security considerations:
 * - Pane IDs are validated before use in shell commands
 * - Text inputs are sanitized to prevent command injection
 */

import { execSync, spawnSync } from 'child_process';
import type { TmuxPane, PaneAnalysisResult, BlockedPane } from './types.js';

/**
 * Validate tmux pane ID format to prevent command injection
 * Valid formats: %0, %1, %123, etc.
 */
function isValidPaneId(paneId: string): boolean {
  return /^%\d+$/.test(paneId);
}

/**
 * Sanitize text for use in tmux send-keys command
 * Escapes single quotes to prevent command injection
 */
function sanitizeForTmux(text: string): string {
  // Escape single quotes by ending the quote, adding escaped quote, and reopening
  return text.replace(/'/g, "'\\''");
}

/** Rate limit message patterns to detect in pane content */
const RATE_LIMIT_PATTERNS = [
  /rate limit/i,
  /usage limit/i,
  /quota exceeded/i,
  /too many requests/i,
  /please wait/i,
  /try again later/i,
  /limit reached/i,
  /hit your limit/i,
  /hit .+ limit/i,
  /resets? .+ at/i,
  /5[- ]?hour/i,
  /weekly/i,
];

/** Patterns that indicate Claude Code is running */
const CLAUDE_CODE_PATTERNS = [
  /claude/i,
  /anthropic/i,
  /\$ claude/,
  /claude code/i,
  /conversation/i,
  /assistant/i,
];

/** Patterns that indicate the pane is waiting for user input */
const WAITING_PATTERNS = [
  /\[\d+\]/,              // Menu selection prompt like [1], [2], [3]
  /^\s*❯?\s*\d+\.\s/m,     // Menu selection prompt like "❯ 1. ..." or "  2. ..."
  /continue\?/i,           // Continue prompt
  /press enter/i,
  /waiting for/i,
  /select an option/i,
  /choice:/i,
  /enter to confirm/i,
];

/**
 * Check if tmux is installed and available
 */
export function isTmuxAvailable(): boolean {
  if (process.platform === 'win32') {
    return false; // tmux is not available on native Windows
  }
  try {
    const result = spawnSync('which', ['tmux'], {
      encoding: 'utf-8',
      timeout: 2000,
    });
    return result.status === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Check if currently running inside a tmux session
 */
export function isInsideTmux(): boolean {
  return !!process.env.TMUX;
}

/**
 * List all tmux panes across all sessions
 */
export function listTmuxPanes(): TmuxPane[] {
  if (!isTmuxAvailable()) {
    return [];
  }

  try {
    // Format: session_name:window_index.pane_index pane_id pane_active window_name pane_title
    const format = '#{session_name}:#{window_index}.#{pane_index} #{pane_id} #{pane_active} #{window_name} #{pane_title}';
    const result = execSync(`tmux list-panes -a -F '${format}'`, {
      encoding: 'utf-8',
      timeout: 5000,
    });

    const panes: TmuxPane[] = [];

    for (const line of result.trim().split('\n')) {
      if (!line.trim()) continue;

      const parts = line.split(' ');
      if (parts.length < 4) continue;

      const [location, paneId, activeStr, windowName, ...titleParts] = parts;
      const [sessionWindow, paneIndexStr] = location.split('.');
      const [session, windowIndexStr] = sessionWindow.split(':');

      panes.push({
        id: paneId,
        session,
        windowIndex: parseInt(windowIndexStr, 10),
        windowName,
        paneIndex: parseInt(paneIndexStr, 10),
        title: titleParts.join(' ') || undefined,
        isActive: activeStr === '1',
      });
    }

    return panes;
  } catch (error) {
    console.error('[TmuxDetector] Error listing panes:', error);
    return [];
  }
}

/**
 * Capture the content of a specific tmux pane
 *
 * @param paneId - The tmux pane ID (e.g., "%0")
 * @param lines - Number of lines to capture (default: 15)
 */
export function capturePaneContent(paneId: string, lines = 15): string {
  if (!isTmuxAvailable()) {
    return '';
  }

  // Validate pane ID to prevent command injection
  if (!isValidPaneId(paneId)) {
    console.error(`[TmuxDetector] Invalid pane ID format: ${paneId}`);
    return '';
  }

  // Validate lines is a reasonable positive integer
  const safeLines = Math.max(1, Math.min(100, Math.floor(lines)));

  try {
    // Capture the last N lines from the pane
    const result = execSync(`tmux capture-pane -t '${paneId}' -p -S -${safeLines}`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return result;
  } catch (error) {
    console.error(`[TmuxDetector] Error capturing pane ${paneId}:`, error);
    return '';
  }
}

/**
 * Analyze pane content to determine if it shows a rate-limited Claude Code session
 */
export function analyzePaneContent(content: string): PaneAnalysisResult {
  if (!content.trim()) {
    return {
      hasClaudeCode: false,
      hasRateLimitMessage: false,
      isBlocked: false,
      confidence: 0,
    };
  }

  // Check for Claude Code indicators
  const hasClaudeCode = CLAUDE_CODE_PATTERNS.some((pattern) =>
    pattern.test(content)
  );

  // Check for rate limit messages
  const rateLimitMatches = RATE_LIMIT_PATTERNS.filter((pattern) =>
    pattern.test(content)
  );
  const hasRateLimitMessage = rateLimitMatches.length > 0;

  // Check if waiting for user input
  const isWaiting = WAITING_PATTERNS.some((pattern) => pattern.test(content));

  // Determine rate limit type
  let rateLimitType: 'five_hour' | 'weekly' | 'unknown' | undefined;
  if (hasRateLimitMessage) {
    if (/5[- ]?hour/i.test(content)) {
      rateLimitType = 'five_hour';
    } else if (/weekly/i.test(content)) {
      rateLimitType = 'weekly';
    } else {
      rateLimitType = 'unknown';
    }
  }

  // Calculate confidence
  let confidence = 0;
  if (hasClaudeCode) confidence += 0.4;
  if (hasRateLimitMessage) confidence += 0.4;
  if (isWaiting) confidence += 0.2;
  if (rateLimitMatches.length > 1) confidence += 0.1; // Multiple matches = higher confidence

  // Determine if blocked
  const isBlocked = hasClaudeCode && hasRateLimitMessage && confidence >= 0.6;

  return {
    hasClaudeCode,
    hasRateLimitMessage,
    isBlocked,
    rateLimitType,
    confidence: Math.min(1, confidence),
  };
}

/**
 * Scan all tmux panes for blocked Claude Code sessions
 *
 * @param lines - Number of lines to capture from each pane
 */
export function scanForBlockedPanes(lines = 15): BlockedPane[] {
  const panes = listTmuxPanes();
  const blocked: BlockedPane[] = [];

  for (const pane of panes) {
    const content = capturePaneContent(pane.id, lines);
    const analysis = analyzePaneContent(content);

    if (analysis.isBlocked) {
      blocked.push({
        ...pane,
        analysis,
        firstDetectedAt: new Date(),
        resumeAttempted: false,
      });
    }
  }

  return blocked;
}

/**
 * Send resume sequence to a tmux pane
 *
 * This sends "1" followed by Enter to select the first option (usually "Continue"),
 * then waits briefly and sends "continue" if needed.
 *
 * @param paneId - The tmux pane ID
 * @returns Whether the command was sent successfully
 */
export function sendResumeSequence(paneId: string): boolean {
  if (!isTmuxAvailable()) {
    return false;
  }

  // Validate pane ID to prevent command injection
  if (!isValidPaneId(paneId)) {
    console.error(`[TmuxDetector] Invalid pane ID format: ${paneId}`);
    return false;
  }

  try {
    // Send "1" to select the first option (typically "Continue" or similar)
    execSync(`tmux send-keys -t '${paneId}' '1' Enter`, {
      timeout: 2000,
    });

    // Wait a moment for the response
    // Note: In real usage, we should verify the pane state changed
    return true;
  } catch (error) {
    console.error(`[TmuxDetector] Error sending resume to pane ${paneId}:`, error);
    return false;
  }
}

/**
 * Send custom text to a tmux pane
 */
export function sendToPane(paneId: string, text: string, pressEnter = true): boolean {
  if (!isTmuxAvailable()) {
    return false;
  }

  // Validate pane ID to prevent command injection
  if (!isValidPaneId(paneId)) {
    console.error(`[TmuxDetector] Invalid pane ID format: ${paneId}`);
    return false;
  }

  try {
    const sanitizedText = sanitizeForTmux(text);
    const enterSuffix = pressEnter ? ' Enter' : '';
    execSync(`tmux send-keys -t '${paneId}' '${sanitizedText}'${enterSuffix}`, {
      timeout: 2000,
    });
    return true;
  } catch (error) {
    console.error(`[TmuxDetector] Error sending to pane ${paneId}:`, error);
    return false;
  }
}

/**
 * Get a summary of blocked panes for display
 */
export function formatBlockedPanesSummary(blockedPanes: BlockedPane[]): string {
  if (blockedPanes.length === 0) {
    return 'No blocked Claude Code sessions detected.';
  }

  const lines: string[] = [
    `Found ${blockedPanes.length} blocked Claude Code session(s):`,
    '',
  ];

  for (const pane of blockedPanes) {
    const location = `${pane.session}:${pane.windowIndex}.${pane.paneIndex}`;
    const confidence = Math.round(pane.analysis.confidence * 100);
    const limitType = pane.analysis.rateLimitType || 'unknown';
    const status = pane.resumeAttempted
      ? pane.resumeSuccessful
        ? ' [RESUMED]'
        : ' [RESUME FAILED]'
      : '';

    lines.push(`  • ${location} (${pane.id}) - ${limitType} limit, ${confidence}% confidence${status}`);
  }

  return lines.join('\n');
}
