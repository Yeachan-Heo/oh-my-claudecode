/**
 * Rate Limit Wait - Type Definitions
 *
 * Types for the rate limit auto-resume daemon.
 * Reference: https://github.com/EvanOman/cc-wait
 */

export interface RateLimitStatus {
  /** Whether rate limited on 5-hour window */
  fiveHourLimited: boolean;
  /** Whether rate limited on weekly window */
  weeklyLimited: boolean;
  /** Combined: true if either limit is hit */
  isLimited: boolean;
  /** When 5-hour limit resets */
  fiveHourResetsAt: Date | null;
  /** When weekly limit resets */
  weeklyResetsAt: Date | null;
  /** Earliest reset time */
  nextResetAt: Date | null;
  /** Time until reset in milliseconds */
  timeUntilResetMs: number | null;
  /** Last check timestamp */
  lastCheckedAt: Date;
}

export interface TmuxPane {
  /** Pane ID (e.g., "%0") */
  id: string;
  /** Session name */
  session: string;
  /** Window index */
  windowIndex: number;
  /** Window name */
  windowName: string;
  /** Pane index within window */
  paneIndex: number;
  /** Pane title (if set) */
  title?: string;
  /** Whether this pane is currently active */
  isActive: boolean;
}

export interface PaneAnalysisResult {
  /** Whether this pane appears to have Claude Code */
  hasClaudeCode: boolean;
  /** Whether rate limit message is visible */
  hasRateLimitMessage: boolean;
  /** Whether the pane appears blocked (waiting for input) */
  isBlocked: boolean;
  /** Detected rate limit type if any */
  rateLimitType?: 'five_hour' | 'weekly' | 'unknown';
  /** Confidence level (0-1) */
  confidence: number;
}

export interface BlockedPane extends TmuxPane {
  /** Analysis result for this pane */
  analysis: PaneAnalysisResult;
  /** When this pane was first detected as blocked */
  firstDetectedAt: Date;
  /** Whether resume has been attempted */
  resumeAttempted: boolean;
  /** Whether resume was successful */
  resumeSuccessful?: boolean;
}

export interface DaemonState {
  /** Whether daemon is running */
  isRunning: boolean;
  /** Process ID if running */
  pid: number | null;
  /** When daemon started */
  startedAt: Date | null;
  /** Last poll timestamp */
  lastPollAt: Date | null;
  /** Current rate limit status */
  rateLimitStatus: RateLimitStatus | null;
  /** Currently tracked blocked panes */
  blockedPanes: BlockedPane[];
  /** Panes that have been resumed (to avoid re-sending) */
  resumedPaneIds: string[];
  /** Total resume attempts */
  totalResumeAttempts: number;
  /** Successful resume count */
  successfulResumes: number;
  /** Error count */
  errorCount: number;
  /** Last error message */
  lastError?: string;
}

export interface DaemonConfig {
  /** Polling interval in milliseconds (default: 60000 = 1 minute) */
  pollIntervalMs?: number;
  /** Number of pane lines to capture for analysis (default: 15) */
  paneLinesToCapture?: number;
  /** Whether to log verbose output (default: false) */
  verbose?: boolean;
  /** State file path (default: ~/.omc/state/rate-limit-daemon.json) */
  stateFilePath?: string;
  /** PID file path (default: ~/.omc/state/rate-limit-daemon.pid) */
  pidFilePath?: string;
  /** Log file path (default: ~/.omc/state/rate-limit-daemon.log) */
  logFilePath?: string;
}

export interface ResumeResult {
  /** Pane ID */
  paneId: string;
  /** Whether resume was successful */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Timestamp */
  timestamp: Date;
}

export interface DaemonCommand {
  action: 'start' | 'stop' | 'status' | 'detect';
  options?: DaemonConfig;
}

export interface DaemonResponse {
  success: boolean;
  message: string;
  state?: DaemonState;
  error?: string;
}
