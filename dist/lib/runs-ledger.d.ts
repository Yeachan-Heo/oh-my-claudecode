/**
 * Run ledger (P2 Part A, contract: docs/design/P2-RUN-LEDGER-AND-INTAKE-PLAN.md).
 *
 * Append-only JSONL at `<omcRoot>/state/runs/ledger.jsonl` recording the
 * lifecycle edges of watched unattended modes. Mode state files are wiped by
 * cancel BEFORE the Stop event fires, so a durable trace that survives cancel
 * is the prerequisite for any closeout reconciliation: without this ledger,
 * "did the run write its closeout?" is unanswerable after the fact.
 *
 * Evidence by contract: append failures are swallowed. The ledger is
 * promotion/audit evidence — a broken ledger must never break the state
 * write or clear it observes.
 */
/** The unattended modes whose lifecycle edges are recorded. */
export declare const WATCHED_RUN_MODES: readonly ["ralph", "autopilot", "team", "ultragoal"];
export type WatchedRunMode = (typeof WATCHED_RUN_MODES)[number];
export interface RunLedgerEntry {
    ts: string;
    run: string;
    sessionId?: string;
    event: 'start' | 'end';
    outcome?: 'running' | 'completed' | 'failed' | 'cancelled';
    closeoutWritten?: boolean;
}
export declare function isWatchedRunMode(modeName: string): modeName is WatchedRunMode;
/** True when the mode's notepad gained a write after the run started. */
export declare function closeoutWrittenFor(omcRoot: string, mode: string, startedAt: string | undefined): boolean;
/**
 * Append one lifecycle edge. sessionId is included when the state file is
 * session-scoped so the reconciler can attribute the entry.
 */
export declare function appendRunLedger(omcRoot: string, entry: RunLedgerEntry): void;
/**
 * Observe a successful state write: append a `start` edge when a watched
 * mode's state becomes active. Idempotent per process — repeated writes of
 * an already-active state do not duplicate the start edge.
 */
export declare function observeModeStateWrite(omcRoot: string, filePath: string, state: Record<string, unknown>): void;
/**
 * Observe a conditional state write: append a `start` edge when a watched
 * mode goes from inactive (or absent) to active. The transition is the
 * idempotency guard, so this does not consult the per-process map, which a
 * clear in another process leaves stale.
 */
export declare function observeModeStateActivation(omcRoot: string, filePath: string, previous: Record<string, unknown> | null | undefined, next: Record<string, unknown>): void;
/**
 * Observe a successful state clear: append an `end` edge when a watched
 * mode's previously-active state is removed, carrying the outcome and the
 * closeout flag computed against the run's notepad.
 */
export declare function observeModeStateClear(omcRoot: string, filePath: string, previousState: Record<string, unknown> | null): void;
//# sourceMappingURL=runs-ledger.d.ts.map