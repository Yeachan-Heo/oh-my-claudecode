/**
 * Idle Pane Nudge for Team MCP Wait
 *
 * Detects idle teammate panes during omc_run_team_wait polling and sends
 * tmux send-keys continuation nudges. Only nudges worker panes (never the
 * leader) in the current team session.
 *
 * Idle = classifyPane reads the pane as idle (a prompt is drawn, and no trust
 * dialog, active task or startup status line is on screen), and the pane also
 * looks ready the way the checks that send keys read it.
 *
 * @see https://github.com/anthropics/oh-my-claudecode/issues/1047
 */
import { type WorkerPaneOwnership } from './tmux-session.js';
import { type TeamInstanceId, type TmuxServerIdentity } from './types.js';
import type { WorkerProviderLiveness } from './worker-provider-liveness.js';
export interface NudgeConfig {
    /** Milliseconds a pane must be idle before the first nudge (default: 30000) */
    delayMs: number;
    /** Maximum number of nudges per pane per wait call (default: 3) */
    maxCount: number;
    /** Text sent to the pane as a nudge (default below) */
    message: string;
}
export interface NudgeAuthority {
    /** Original durable team incarnation from the job record. */
    instanceId: TeamInstanceId;
    /** Exact persisted provider/session target from the team config. */
    sessionName: string;
    /** Tmux server incarnation captured when the team was created. */
    tmuxServerIdentity?: TmuxServerIdentity;
    /** Provider inferred from the persisted target when omitted. */
    provider?: 'tmux' | 'cmux' | 'herdr';
    /**
     * Return the exact provider ownership for one persisted worker pane.
     * Missing ownership is never replaced with ambient pane capture.
     */
    getPaneOwnership: (paneId: string) => WorkerPaneOwnership | undefined;
    /**
     * Provider liveness for one persisted worker pane. A `dead` provider leaves
     * a shell prompt that reads as idle, so it is never nudged.
     */
    getProviderLiveness: (paneId: string) => Promise<WorkerProviderLiveness>;
    /**
     * Perform final authority validation and transport while holding the
     * original instance lifecycle lock. Returning false means no delivery was
     * proven and must not increment counters.
     */
    executeNudge: (paneId: string, message: string) => Promise<boolean>;
}
export declare const DEFAULT_NUDGE_CONFIG: NudgeConfig;
/** Capture the last 80 lines of a team pane. Returns '' on error. */
export declare function capturePane(ownership: WorkerPaneOwnership): Promise<string>;
/**
 * A pane is idle when it shows a prompt and nothing else claims it: no trust
 * dialog, no active task and no startup status line. A nudge types into the
 * pane, so it also needs the pane to look ready the way the checks that send
 * keys have always read it: a draft that mentions "loading" stays untouched.
 */
export declare function isPaneIdle(ownership: WorkerPaneOwnership): Promise<boolean>;
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
     * @param authority   - Original instance and exact persisted provider target
     */
    checkAndNudge(paneIds: string[], leaderPaneId: string | undefined, authority: NudgeAuthority): Promise<string[]>;
    /** Summary of nudge activity per pane. */
    getSummary(): Record<string, {
        nudgeCount: number;
        lastNudgeAt: number | null;
    }>;
    /** Total nudges sent across all panes. */
    get totalNudges(): number;
}
//# sourceMappingURL=idle-nudge.d.ts.map