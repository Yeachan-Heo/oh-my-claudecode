/**
 * Remote approval gate (graph runtime v2).
 *
 * Bridges the frozen HumanApprovalPrompter contract to a file-backed
 * decision exchange plus an optional notifier, so approvals can be
 * granted from outside the interactive terminal (via `omc graph
 * approvals decide`, and later via notification reply channels).
 *
 * Protocol (all files live inside the contained run directory):
 *   <runDir>/approvals/pending/<activationId>.json    written by the gate
 *   <runDir>/approvals/decisions/<activationId>.json  written by a decider
 *
 * Fail-closed by construction, mirroring createStdinApprovalGate:
 *   - malformed or unknown decisions never resolve a request (the gate
 *     keeps waiting for a well-formed one)
 *   - an expired request resolves to the configured timeout policy
 *     (default: denied)
 *   - decision artifacts carry no trust: the runner records the outcome
 *     in its own journal, so a forged decision file can only flip a
 *     human-approval node, exactly like typing y at the stdin prompt
 */
import type { ApprovalRequest, HumanApprovalPrompter } from "./types.js";
type Decision = "approved" | "denied";
/** Persisted pending-request artifact (one per activation). */
export interface PendingApprovalRecord {
    readonly run_id: string;
    readonly node_id: string;
    readonly activation_id: string;
    readonly prompt_text: string;
    readonly created_at: string;
}
/** Persisted decision artifact (one per activation). */
export interface ApprovalDecisionRecord {
    readonly decision: Decision;
    readonly decided_by?: string;
    readonly decided_at: string;
}
/** One row surfaced by listPendingApprovals / `omc graph approvals list`. */
export interface PendingApprovalEntry {
    readonly run_id: string;
    readonly activation_id: string;
    readonly node_id: string;
    readonly prompt_text: string;
    readonly created_at: string;
}
export interface RemoteApprovalGateOptions {
    readonly runsRoot: string;
    readonly runId: string;
    /** Poll cadence for decision artifacts (default 2000ms). */
    readonly pollIntervalMs?: number;
    /** Max wait before the timeout policy applies (default: wait forever). */
    readonly timeoutMs?: number;
    /** Resolution for an expired request (default "denied" — fail closed). */
    readonly timeoutPolicy?: Decision;
    /** AbortSignal observed between polls; an aborted wait resolves denied. */
    readonly signal?: AbortSignal;
    /** Best-effort delivery hook (notification channels). Errors are swallowed. */
    readonly notifier?: (request: ApprovalRequest, record: PendingApprovalRecord) => void | Promise<void>;
    /** Injectable clock + sleep for tests. */
    readonly now?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
}
/**
 * Parse one decision artifact. Returns null for anything that is not a
 * well-formed decision — malformed files are ignored, never trusted.
 */
export declare function parseDecisionArtifact(raw: string): ApprovalDecisionRecord | null;
/**
 * Create a remote approval gate. Each prompt persists a pending artifact,
 * fires the best-effort notifier once, then polls for a decision artifact
 * until one resolves or the optional timeout expires.
 */
export declare function createRemoteApprovalGate(options: RemoteApprovalGateOptions): HumanApprovalPrompter;
/**
 * List unresolved approval requests across all runs in a runs root.
 * Read-only: runs with malformed or unreadable artifacts are skipped.
 */
export declare function listPendingApprovals(runsRoot: string): PendingApprovalEntry[];
/**
 * Persist one decision artifact on behalf of a human decider (the
 * `omc graph approvals decide` CLI path). Fails closed on malformed ids
 * and on unknown runs: the run directory must already exist (the gate
 * creates it), so a typo'd run id is an error rather than a decision
 * written into a directory nobody polls.
 */
export declare function writeApprovalDecision(runsRoot: string, runId: string, activationId: string, decision: Decision, decidedBy?: string): ApprovalDecisionRecord;
/** Remove a run's pending artifact directory (best-effort housekeeping). */
export declare function prunePendingApprovals(runsRoot: string, runId: string): void;
export {};
//# sourceMappingURL=remote-approval.d.ts.map