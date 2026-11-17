import type { OpenClawContext, OpenClawHookEvent, OpenClawSignal } from "./types.js";
/**
 * How long after a terminal-state event (stop/session-end) to suppress
 * late lifecycle events for the same {projectPath}::{tmuxSession} scope.
 *
 * Chosen to be long enough to absorb hook-ordering races (sub-process startup
 * delays, detach/re-attach timing) while being short enough not to swallow
 * genuinely new sessions that start shortly after a cleanup.
 */
export declare const TERMINAL_STATE_SUPPRESSION_WINDOW_MS = 60000;
interface DedupeStateRecord {
    event: OpenClawHookEvent;
    routeKey: string;
    tmuxSession: string;
    lastSeenAt: string;
    count: number;
}
interface DedupeState {
    updatedAt: string;
    records: Record<string, DedupeStateRecord>;
}
/**
 * Returns true when `event` is a late lifecycle event that has been rendered
 * obsolete by a prior terminal-state record in `state`.
 *
 * Guards:
 *   - session-start arriving after session.stopped or session.finished → suppress
 *   - stop arriving after session.finished → suppress
 *
 * The check window is TERMINAL_STATE_SUPPRESSION_WINDOW_MS.  Obsolete events
 * must NOT update dedupe state so the terminal record stays alive for further
 * suppression checks within the same window.
 */
export declare function isObsoleteAfterTerminalState(event: OpenClawHookEvent, state: DedupeState, tmuxSession: string, projectPath: string, nowMs: number): boolean;
export declare function shouldCollapseOpenClawBurst(event: OpenClawHookEvent, signal: OpenClawSignal, context: OpenClawContext, tmuxSession: string | undefined): boolean;
export {};
//# sourceMappingURL=dedupe.d.ts.map