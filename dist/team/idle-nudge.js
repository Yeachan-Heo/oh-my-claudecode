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
import { execFile } from 'child_process';
import { paneLooksReady, paneHasActiveTask, sendToWorker } from './tmux-session.js';
export const DEFAULT_NUDGE_CONFIG = {
    delayMs: 30_000,
    maxCount: 3,
    message: 'Continue working on your assigned task.',
};
// ---------------------------------------------------------------------------
// Pane capture + idle detection
// ---------------------------------------------------------------------------
/** Capture the last 80 lines of a tmux pane. Returns '' on error. */
export function capturePane(paneId) {
    return new Promise((resolve) => {
        execFile('tmux', ['capture-pane', '-t', paneId, '-p', '-S', '-80'], (err, stdout) => {
            if (err)
                resolve('');
            else
                resolve(stdout ?? '');
        });
    });
}
/**
 * A pane is idle when it shows a prompt (ready for input) but has no
 * active task running.
 */
export async function isPaneIdle(paneId) {
    const captured = await capturePane(paneId);
    if (!captured)
        return false;
    return paneLooksReady(captured) && !paneHasActiveTask(captured);
}
export class NudgeTracker {
    config;
    states = new Map();
    /** Minimum interval between idle-detection scans (ms). */
    scanIntervalMs = 5_000;
    lastScanAt = 0;
    constructor(config) {
        this.config = { ...DEFAULT_NUDGE_CONFIG, ...config };
    }
    /**
     * Check worker panes for idle state and nudge when appropriate.
     * Returns pane IDs that were nudged in this call.
     *
     * @param paneIds   - Worker pane IDs from the job's panes file
     * @param leaderPaneId - Leader pane ID (never nudged)
     * @param sessionName  - Tmux session name (passed to sendToWorker)
     */
    async checkAndNudge(paneIds, leaderPaneId, sessionName) {
        const now = Date.now();
        // Throttle: skip if last scan was too recent
        if (now - this.lastScanAt < this.scanIntervalMs)
            return [];
        this.lastScanAt = now;
        const nudged = [];
        for (const paneId of paneIds) {
            // Never nudge the leader pane
            if (paneId === leaderPaneId)
                continue;
            let state = this.states.get(paneId);
            if (!state) {
                state = { nudgeCount: 0, firstIdleAt: null, lastNudgeAt: null };
                this.states.set(paneId, state);
            }
            // Max nudges reached for this pane — skip
            if (state.nudgeCount >= this.config.maxCount)
                continue;
            const idle = await isPaneIdle(paneId);
            if (!idle) {
                // Pane is active — reset idle tracking
                state.firstIdleAt = null;
                continue;
            }
            // Record when we first detected idle
            if (state.firstIdleAt === null) {
                state.firstIdleAt = now;
            }
            // Has the pane been idle long enough?
            if (now - state.firstIdleAt < this.config.delayMs)
                continue;
            // Send the nudge
            const ok = await sendToWorker(sessionName, paneId, this.config.message);
            if (ok) {
                state.nudgeCount++;
                state.lastNudgeAt = now;
                // Reset idle timer so the next nudge waits another full delay
                state.firstIdleAt = null;
                nudged.push(paneId);
            }
        }
        return nudged;
    }
    /** Summary of nudge activity per pane. */
    getSummary() {
        const out = {};
        for (const [paneId, state] of this.states) {
            if (state.nudgeCount > 0) {
                out[paneId] = { nudgeCount: state.nudgeCount, lastNudgeAt: state.lastNudgeAt };
            }
        }
        return out;
    }
    /** Total nudges sent across all panes. */
    get totalNudges() {
        let total = 0;
        for (const state of this.states.values()) {
            total += state.nudgeCount;
        }
        return total;
    }
}
//# sourceMappingURL=idle-nudge.js.map