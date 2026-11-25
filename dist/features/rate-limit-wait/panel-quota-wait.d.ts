import { readProviderQuota } from './panel-quota-reading.js';
export { readProviderQuota };
export type PanelEnv = Readonly<Record<string, string | undefined>>;
export interface PanePoint {
    id: string;
    session: string;
    windowIndex: number;
    paneIndex: number;
    /**
     * Incarnation of the tmux server that listed the pane. A pane id is unique only within one server run: after a
     * server restart the same id can name an unrelated worker. Undefined when the listing carries no such value.
     */
    server?: string;
    /** Private tmux endpoint (`-S` path) of the server the pane belongs to; undefined for the default server. */
    socket?: string;
}
/** Provider reading: the raw JSON body with `data.limits` (or a bare array of limits). */
export interface QuotaReading {
    body: unknown;
}
/**
 * Outcome of the continue key, the one effect of a pass that cannot be taken back: `delivered` (text and Enter went
 * in), `not_attempted` (nothing was sent, so the key may be sent again), `unconfirmed` (the text may be typed in
 * the pane without its Enter, or a call timed out: it is never sent again).
 */
export type ResumeDelivery = 'delivered' | 'not_attempted' | 'unconfirmed';
export interface PanelTmux {
    /** The panes of the tmux server, or null when the inventory cannot be read (tmux missing, server unreachable, timeout). */
    listPanes(): PanePoint[] | null;
    capture(pane: PanePoint, lines: number): string | null;
    sendContinue(pane: PanePoint): ResumeDelivery;
    /** Whether the provider still runs in the pane: false for a dead pane or a shell in the foreground, null when it cannot be told. */
    providerRunning(pane: PanePoint): boolean | null;
    /**
     * What identifies the program that holds the pane's terminal now (its process group and start time), or null when it
     * cannot be told. Read when a wait begins and again before a key is sent: a pane whose provider exited and that now runs
     * another program is not the pane that was waiting.
     */
    providerIdentity?(pane: PanePoint): string | null;
}
export interface PanelEntry {
    key: string;
    pane: string;
    session: string;
    windowIndex: number;
    paneIndex: number;
    /** Incarnation of the tmux server the pane id belongs to, set when the entry is created and never refreshed (see PanePoint.server). */
    server?: string;
    waits: number;
    /** The program that held the pane's terminal when the wait began (see PanelTmux.providerIdentity); a key goes only to that program. */
    providerIdentity?: string;
    /** "resuming": the continue key is about to be sent, or was sent without the pass finishing; it is never sent again. */
    state?: 'waiting_quota' | 'resuming' | 'resumed' | 'quota-ended';
    /**
     * Set on a "resumed" pane whose continue key may have been typed without being submitted (a partial send, a timeout,
     * or a daemon that stopped between the intent and the result). No key is sent to the pane while the quota error is
     * still on its screen: a second key would be typed after the first. Cleared when the error is gone.
     */
    unconfirmed?: boolean;
    sig?: string | null;
    updatedAt?: number;
    resumedAt?: number;
    untilMs?: number;
    resetMs?: number | null;
}
export interface PanelState {
    panes: Record<string, PanelEntry>;
    /** Key of the pane the next pass starts at, after a pass that ran out of time (see runPanelQuotaPass). */
    cursor?: string;
}
export interface QuotaCodes {
    wait: number[];
    end: number[];
}
export type WaitPlan = {
    wait: true;
    reset: number;
    untilMs: number;
} | {
    wait: false;
    reason: string;
    reset?: number;
};
type Journal = Record<string, unknown>;
export interface PanelQuotaDeps {
    now(): number;
    monotonic?(): number;
    listPanes(): PanePoint[] | null;
    capture(pane: PanePoint, lines: number): string | null | undefined;
    sendContinue(pane: PanePoint): ResumeDelivery;
    providerRunning(pane: PanePoint): boolean | null;
    providerIdentity?(pane: PanePoint): string | null;
    readQuota(): Promise<QuotaReading | null>;
    log(text: string): void;
    journal(row: Journal): void;
    /** Saves the state durably. Called before an effect that cannot be undone; a throw stops that effect. */
    persist?(state: PanelState): void;
}
export declare function detectQuotaError(content: string, codes: QuotaCodes): {
    code: number;
} | null;
export declare function wrapperOwnsPane(content: string, pattern: RegExp): boolean;
export declare function paneKey(pane: PanePoint): string;
/**
 * Reads the state file. A file that does not exist is an empty state; a file that cannot be read, parsed or does not
 * have the shape of a state throws. A pass that took an unreadable file for an empty one would overwrite the saved
 * waits and resume intents, and could send again a key that was already delivered.
 */
export declare function loadState(file: string): PanelState;
export declare function saveState(file: string, state: PanelState): void;
/**
 * Pure decision on a provider reading. Takes limits with percentage >= 100; the unblock time is the latest
 * nextResetTime among them. Waits only if that reset is at most `windowMs` away and no weekly limit is
 * exhausted; otherwise the wait ends. Missing reading, no exhausted limit or no positive reset: no wait.
 */
export declare function planQuotaWait(body: unknown, now: number, windowMs?: number, marginValueMs?: number, weekUnit?: number): WaitPlan;
export declare function passLimitMs(env: PanelEnv): number;
/**
 * One pass over the team panes. Mutates and returns `state`; the caller saves it at the end of the pass, and
 * `deps.persist` saves it before a continue key is sent (see the header).
 * With the switch off, returns `state` untouched and calls no dependency.
 */
export declare function runPanelQuotaPass(state: PanelState, deps: PanelQuotaDeps, env?: PanelEnv): Promise<PanelState>;
/**
 * Entry point for the daemon: one pass per poll. Returns the state, or null when the switch is off or the saved state
 * cannot be read (no reads of the provider, no tmux calls, no file writes).
 */
export declare function runDaemonPanelQuotaPass({ stateDir, env, tmux, readQuota, log, now, monotonic, }: {
    stateDir: string;
    env?: PanelEnv;
    tmux: PanelTmux;
    readQuota?: () => Promise<QuotaReading | null>;
    log?: (text: string) => void;
    now?: () => number;
    monotonic?: () => number;
}): Promise<PanelState | null>;
//# sourceMappingURL=panel-quota-wait.d.ts.map