/**
 * Wait Command
 *
 * CLI commands for rate limit wait and auto-resume functionality.
 *
 * Design Philosophy (aligned with oh-my-claudecode values):
 * - Zero learning curve: `omc wait` just works
 * - Smart defaults: Auto-detects tmux and daemon status
 * - Minimal commands: Most users only need `omc wait`
 *
 * Commands:
 *   omc wait               - Smart command: shows status, offers to start daemon if needed
 *   omc wait status        - Show current rate limit and daemon status
 *   omc wait daemon start  - Start the background daemon
 *   omc wait daemon stop   - Stop the daemon
 *   omc wait detect        - Scan for blocked Claude Code sessions
 */
export interface WaitOptions {
    json?: boolean;
    start?: boolean;
    stop?: boolean;
}
export interface WaitStatusOptions {
    json?: boolean;
}
export interface WaitDaemonOptions {
    verbose?: boolean;
    foreground?: boolean;
    interval?: number;
}
export interface WaitDetectOptions {
    json?: boolean;
    lines?: number;
}
/**
 * Smart wait command - the main entry point
 * Follows "zero learning curve" philosophy
 */
export declare function waitCommand(options: WaitOptions): Promise<void>;
/**
 * Show current rate limit and daemon status
 */
export declare function waitStatusCommand(options: WaitStatusOptions): Promise<void>;
/**
 * Start/stop the daemon
 */
export declare function waitDaemonCommand(action: 'start' | 'stop', options: WaitDaemonOptions): Promise<void>;
/**
 * Detect blocked Claude Code sessions
 */
export declare function waitDetectCommand(options: WaitDetectOptions): Promise<void>;
//# sourceMappingURL=wait.d.ts.map