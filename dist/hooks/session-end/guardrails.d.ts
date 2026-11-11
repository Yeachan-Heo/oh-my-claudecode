/**
 * Chain-level guardrails for factory automation (spec: 软件工厂闭环 T3).
 *
 * Two checks, consumed by the spawn stage (T2) before launching the next
 * chained session:
 * - Serial single-session: at most one active session per intent chain,
 *   via an exclusive long-lived file lock (src/lib/file-lock.ts).
 * - Daily cap: at most N links per intent per local calendar day; the
 *   counter persists across sessions under the OMC state root.
 *
 * Rejections leave an audit marker (留痕) on disk.
 */
import { type FileLockHandle } from "../../lib/file-lock.js";
/** Chain-level cap: links per intent per local calendar day (mission brief #8). */
export declare const DAILY_CHAIN_LIMIT = 10;
/** Read the effective daily cap: `OMC_DAILY_CHAIN_LIMIT` env override, else the default. */
export declare function dailyChainLimit(): number;
/**
 * intentIds land in lock/stop-marker file names, so the charset is a security
 * boundary: word chars, dot, hyphen only — no separators, no traversal.
 */
export declare const INTENT_ID_PATTERN: RegExp;
export interface ChainSlotPermit {
    intentId: string;
    serialLock: FileLockHandle;
    dateKey: string;
    linkIndex: number;
}
export type ChainSlotRejection = {
    allowed: false;
    reason: "serial-conflict" | "daily-cap" | "invalid-intent-id";
    detail: string;
};
export type ChainSlotResult = ({
    allowed: true;
} & ChainSlotPermit) | ChainSlotRejection;
interface StopMarker {
    intentId: string;
    reason: string;
    dateKey: string;
    count: number;
    stoppedAt: string;
}
/** Local calendar day key, e.g. 2026-09-28. */
export declare function chainDayKey(now?: Date): string;
/**
 * Claim the right to launch the next chained session for an intent.
 *
 * Atomically (under the usage file's short critical-section lock):
 * 1. serial lock — O_EXCL create; held = a link is already active
 * 2. daily counter — reject at the (N+1)th link of the local day, leave a stop marker
 *
 * The serial lock is held until releaseChainSlot. The daily count is NOT
 * decremented on release: each launched link consumes one slot for the day.
 */
export declare function acquireChainSlot(intentId: string, stateRoot?: string, now?: Date): ChainSlotResult;
/**
 * Release a claim. Call when the chained session's spawn handoff is done —
 * the permit covers the "one active session" window, not the session runtime.
 */
export declare function releaseChainSlot(permit: ChainSlotPermit): void;
/** Read the audit marker left by a daily-cap rejection, if any. */
export declare function readChainStopMarker(intentId: string, stateRoot?: string): StopMarker | null;
/** Remove a chain's stop marker (after a human re-opens the chain). */
export declare function clearChainStopMarker(intentId: string, stateRoot?: string): void;
export {};
//# sourceMappingURL=guardrails.d.ts.map