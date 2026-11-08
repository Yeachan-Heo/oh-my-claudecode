/**
 * SessionEnd chain enqueuer (spec #9 tracker issue #17).
 *
 * The SessionEnd hook cannot see the session prompt, so chain membership
 * rides a ledger file (`.omc/state/factory/chain-<sessionId>.json`) written
 * by whoever spawned the session (listener / executeSpawnNext). At session
 * end we map the hook reason to a chain outcome, route through the T1 pure
 * seam, grade a declared gate if the ledger carries one, run the guardrails,
 * and enqueue the chain into the spawn-next action payload. Everything here
 * is cheap sync fs — the actual spawn stays in the detached worker.
 */
import { type ChainOutcome, type GateFacts, type GateName, type RouteTable } from './routing.js';
import { type SpawnNextChain, type SpawnNextTracker } from './spawn-next.js';
export interface ChainLedger {
    intentId?: string;
    stage?: string;
    routeTable?: RouteTable;
    tracker?: SpawnNextTracker;
    gate?: GateName;
    gateFacts?: GateFacts;
    /** Per-stage link counts carried forward; guards against route-table self-loops. */
    visits?: Record<string, number>;
    /** User setting-source choice captured by the originating factory link. */
    includeUserSettings?: boolean;
    /** Cap on visits to any one stage before the chain halts. Default 2. */
    maxStageVisits?: number;
}
/**
 * Explicit success allowlist, fail-closed for anything else. Headless sessions
 * that run to completion report 'other' (no failure signal in the SessionEnd
 * payload), so it counts as a normal exit; 'clear' wipes the chain session's
 * context and halts the chain; unknown reasons stay failed.
 */
export declare function sessionEndOutcome(reason: string): ChainOutcome;
export declare function factoryStateDir(directory: string): string;
export declare function readChainLedger(directory: string, sessionId: string): ChainLedger | null;
/** Project-level route table: `.omc/factory-routes.json`. The single source of truth. */
export declare function readProjectRoutes(directory: string): RouteTable | null;
/** Decision audit trail; also used by the worker to correct the record when a spawn fails. */
export declare function recordChainDecision(directory: string, record: Record<string, unknown>): void;
/**
 * Decide whether the ending session continues its chain. Returns the chain
 * payload to merge into the durable SessionEnd payload, or null (no ledger,
 * no route, human gate, guardrail, or invalid ledger — each recorded).
 */
export declare function planChainEnqueue(directory: string, sessionId: string, reason: string): SpawnNextChain | null;
//# sourceMappingURL=chain-enqueuer.d.ts.map