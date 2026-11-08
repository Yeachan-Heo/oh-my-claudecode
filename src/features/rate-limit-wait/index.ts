/**
 * Rate Limit Wait Feature
 *
 * Auto-resume Claude Code sessions when rate limits reset.
 *
 * Usage:
 *   omc wait status         - Show current rate limit status
 *   omc wait daemon start   - Start the background daemon
 *   omc wait daemon stop    - Stop the daemon
 *   omc wait detect         - Scan for blocked Claude Code sessions
 */

// Type exports
export type {
  RateLimitStatus,
  TmuxPane,
  PaneAnalysisResult,
  BlockedPane,
  DaemonState,
  DaemonConfig,
  ResumeResult,
  DaemonCommand,
  DaemonResponse,
} from './types.js';

// Rate limit monitor exports
export {
  checkRateLimitStatus,
  formatTimeUntilReset,
  formatRateLimitStatus,
  isRateLimitStatusDegraded,
  shouldMonitorBlockedPanes,
} from './rate-limit-monitor.js';

// tmux detector exports
export {
  isTmuxAvailable,
  isInsideTmux,
  isPaneAlive,
  listTmuxPanes,
  capturePaneContent,
  analyzePaneContent,
  scanForBlockedPanes,
  sendResumeSequence,
  sendToPane,
  formatBlockedPanesSummary,
} from './tmux-detector.js';

// Daemon exports
export {
  readDaemonState,
  isDaemonRunning,
  startDaemon,
  runDaemonForeground,
  stopDaemon,
  getDaemonStatus,
  detectBlockedPanes,
  formatDaemonState,
} from './daemon.js';
