/**
 * Factory chain watchdog (T4): detects and flags stalled chain links.
 *
 * A ledger without a routeTable is a pre-written first-ring ledger that no
 * enqueuer has taken over yet (the listener writes `{intentId, stage}`;
 * `executeSpawnNext` writes the routeTable-carrying ledger for later links).
 * If such a ledger ages past the threshold, its session never made it to a
 * SessionEnd handoff — stalled. The enqueuer never rewrites or deletes the
 * ledger on consumption, so ledgers whose session already has an 'enqueued'
 * decision in chain-decisions.jsonl are treated as advanced, not stalled.
 *
 * Pure detection + one-shot flagging; scheduling the sweep is the caller's
 * job (event-driven integration, no timers in this module).
 */
import { type SpawnNextTracker } from '../hooks/session-end/spawn-next.js';
export declare const DEFAULT_STALL_THRESHOLD_MS: number;
export declare const HARBOR_NEED_INFO_LABEL = "harbor:need-info";
export interface StalledLink {
    intentId: string;
    /** Session uuid from the ledger file name. */
    session: string;
    stage: string;
    stalledForMs: number;
    tracker?: SpawnNextTracker;
}
export interface DetectStalledOptions {
    stallThresholdMs?: number;
    now?: Date;
}
/**
 * Scan `factoryDir` (`.omc/state/factory`) for stalled chain ledgers:
 * no routeTable, no 'enqueued' decision for the session, mtime older
 * than the threshold.
 */
export declare function detectStalledLinks(factoryDir: string, opts?: DetectStalledOptions): StalledLink[];
export interface WatchdogDeps {
    /** Project root used to resolve the default audit trail; unused when `audit` is injected. */
    cwd: string;
    /** Same shape as ListenerDeps.spawner; defaults to spawn-next's defaultSpawnFn. */
    spawner?: (cmd: string, args: string[]) => void;
    audit?: (record: Record<string, unknown>) => void;
}
export declare function stallAlertComment(stall: StalledLink): string;
/** One-shot alert for a stalled link: tracker issue gets the harbor:need-info label + comment, otherwise audit trail. */
export declare function flagStall(stall: StalledLink, deps: WatchdogDeps): void;
//# sourceMappingURL=watchdog.d.ts.map