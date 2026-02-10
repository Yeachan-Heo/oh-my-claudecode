/**
 * Rate Limit Wait Daemon
 *
 * Background daemon that monitors rate limits and auto-resumes
 * Claude Code sessions when rate limits reset.
 *
 * Security considerations:
 * - State/PID/log files use restrictive permissions (0600)
 * - No sensitive data (tokens, credentials) is logged or stored
 * - Input validation for tmux pane IDs
 *
 * Reference: https://github.com/EvanOman/cc-wait
 */
import type { DaemonState, DaemonConfig, DaemonResponse } from './types.js';
/**
 * Read daemon state from disk
 */
export declare function readDaemonState(config?: DaemonConfig): DaemonState | null;
/**
 * Check if daemon is currently running
 */
export declare function isDaemonRunning(config?: DaemonConfig): boolean;
/**
 * Main daemon polling loop
 */
declare function pollLoop(config: Required<DaemonConfig>): Promise<void>;
/**
 * Start the daemon
 */
export declare function startDaemon(config?: DaemonConfig): DaemonResponse;
/**
 * Run daemon in foreground (for direct execution)
 */
export declare function runDaemonForeground(config?: DaemonConfig): Promise<void>;
/**
 * Stop the daemon
 */
export declare function stopDaemon(config?: DaemonConfig): DaemonResponse;
/**
 * Get daemon status
 */
export declare function getDaemonStatus(config?: DaemonConfig): DaemonResponse;
/**
 * Detect blocked panes (one-time scan)
 */
export declare function detectBlockedPanes(config?: DaemonConfig): Promise<DaemonResponse>;
/**
 * Format daemon state for CLI display
 */
export declare function formatDaemonState(state: DaemonState): string;
export { pollLoop };
//# sourceMappingURL=daemon.d.ts.map