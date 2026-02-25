/**
 * Idle Pane Nudge for Team MCP Wait
 *
 * Detects idle teammate panes during omc_run_team_wait polling and sends
 * tmux send-keys continuation nudges. Only nudges worker panes (never the
 * leader) in the current team session.
 *
 * Idle = pane shows a prompt (paneLooksReady) AND no active task running
 * (paneHasActiveTask is false).
 *
 * @see https://github.com/anthropics/oh-my-claudecode/issues/1047
 */
export interface NudgeConfig {
    /** Milliseconds a pane must be idle before the first nudge (default: 30000) */
    delayMs: number;
    /** Maximum number of nudges per pane per wait call (default: 3) */
    maxCount: number;
    /** Text sent to the pane as a nudge (default below) */
    message: string;
}
export declare const DEFAULT_NUDGE_CONFIG: NudgeConfig;
/** Capture the last 80 lines of a tmux pane. Returns '' on error. */
export declare function capturePane(paneId: string): Promise<string>;
/**
 * A pane is idle when it shows a prompt (ready for input) but has no
 * active task running.
 */
export declare function isPaneIdle(paneId: string): Promise<boolean>;
export declare class NudgeTracker {
    private readonly config;
    private readonly states;
    /** Minimum interval between idle-detection scans (ms). */
    private readonly scanIntervalMs;
    private lastScanAt;
    constructor(config?: Partial<NudgeConfig>);
    /**
     * Check worker panes for idle state and nudge when appropriate.
     * Returns pane IDs that were nudged in this call.
     *
     * @param paneIds   - Worker pane IDs from the job's panes file
     * @param leaderPaneId - Leader pane ID (never nudged)
     * @param sessionName  - Tmux session name (passed to sendToWorker)
     */
    checkAndNudge(paneIds: string[], leaderPaneId: string | undefined, sessionName: string): Promise<string[]>;
    /** Summary of nudge activity per pane. */
    getSummary(): Record<string, {
        nudgeCount: number;
        lastNudgeAt: number | null;
    }>;
    /** Total nudges sent across all panes. */
    get totalNudges(): number;
}
//# sourceMappingURL=idle-nudge.d.ts.map