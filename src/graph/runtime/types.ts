/**
 * Graph Runtime v2 internal contracts.
 *
 * Lead-authored and frozen for the graph-runtime-v2 team. Runtime modules
 * implement these without redefining any Graph Core semantics: the sealed
 * descriptor and pure scheduler contracts in `src/graph/*` remain
 * authoritative and are consumed verbatim (ADR 03570 boundary).
 */

import type {
  GraphApprovalDecision,
  GraphCommittedTransition,
  GraphNode,
  GraphNodeKind,
  GraphSchedulerProjection,
  SealedGraphDescriptor,
  GraphEvidenceReference,
} from "../types.js";

/**
 * Node kinds dispatched to a NodeExecutor. human-approval and join nodes are
 * runner-driven pure transitions (applyHumanApproval / resolveJoin), never
 * executor work.
 */
export type ExecutableKind = Extract<GraphNodeKind, "agent" | "command">;

// ---------------------------------------------------------------------------
// Epoch ownership fence
// ---------------------------------------------------------------------------

/** Content of the run-scoped lock file `<runsRoot>/<run_id>/owner.lock`. */
export interface FenceLockPayload {
  readonly pid: number;
  readonly epoch: number;
  /** Epoch milliseconds at acquisition. */
  readonly timestamp: number;
}

/** Outcome of an acquire attempt against a possibly-existing lock. */
export type FenceAcquireResult =
  | { readonly outcome: "acquired"; readonly epoch: number }
  | { readonly outcome: "busy" };

/**
 * Epoch ownership single-writer fence over one run directory.
 *
 * Protocol invariants (worker-2 implements):
 * - create = O_EXCL; every removal/move = atomic rename with unique target.
 * - stale = PID dead OR unparseable content older than a grace period.
 * - takeover renames the old lock away (exactly one racer wins by ENOENT),
 *   reads old epoch from the tombstone it exclusively owns, O_EXCL creates
 *   the new lock at epoch+1.
 * - live healthy holder yields busy — fail-closed, no multi-writer assumption.
 */
export interface OwnershipFence {
  acquire(): Promise<FenceAcquireResult>;
  /** Throws FenceError("fenced_out") when the caller is not the current owner. */
  assertEpoch(epoch: number): void;
  /** Throws FenceError("fenced_out") when caller is not current owner. */
  /**
   * Atomic release by the current holder. Only the current epoch's holder may
   * release; returns false when this instance no longer owns the run (its
   * rename fails ENOENT because another process already moved the lock).
   */
  release(epoch: number): Promise<boolean>;
}

/** Closed error surface for fence failures surfaced to the runner. */
export class FenceError extends Error {
  readonly code: "busy" | "fenced_out";
  constructor(code: "busy" | "fenced_out", message: string) {
    super(message);
    this.name = "FenceError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// OCC journal
// ---------------------------------------------------------------------------

/**
 * One journal line: an OCC-committed scheduler transition bound to the writer
 * epoch and descriptor. The transition is persisted verbatim from
 * `SchedulerApplyResult.transition`.
 */
export interface JournalRecord {
  /** 0-based append order within the run. */
  readonly seq: number;
  /** Writer epoch that committed this record. */
  readonly epoch: number;
  /** Must equal the projection's descriptor_hash; replay rejects drift. */
  readonly descriptor_hash: string;
  readonly transition: GraphCommittedTransition;
  /** SHA-256 over the complete envelope, including epoch and transition. */
  readonly journal_fingerprint: string;
}

/** Journal append input before the runtime computes its envelope fingerprint. */
export type JournalAppendRecord = Omit<JournalRecord, "journal_fingerprint">;

/**
 * Append-only OCC journal over `<runsRoot>/<run_id>/journal.jsonl`.
 * Epoch-staleness enforcement lives in the runner's loop and commit boundary;
 * the journal fingerprint binds each record to its writer epoch.
 */
export interface Journal {
  append(record: JournalAppendRecord): Promise<void>;
  /**
   * Reads all well-formed records. Throws JournalCorruptionError (with
   * truncatedCount) on any unparseable/incomplete line — never returns
   * partial data silently (AC-8).
   */
  readAll(): Promise<readonly JournalRecord[]>;
}

/** Journal is corrupt or has an incomplete trailing line (fail-closed). */
export class JournalCorruptionError extends Error {
  /** Number of trailing incomplete/unparseable records dropped by readAll. */
  readonly truncatedCount: number;
  constructor(message: string, truncatedCount: number) {
    if (!Number.isInteger(truncatedCount) || truncatedCount < 1) {
      throw new Error("truncatedCount must be a positive integer");
    }
    super(message);
    this.name = "JournalCorruptionError";
    this.truncatedCount = truncatedCount;
  }
}

// ---------------------------------------------------------------------------
// Projection snapshot store
// ---------------------------------------------------------------------------

/**
 * Persisted projection snapshot envelope (projection.json). The journal is
 * the source of truth; the snapshot accelerates resume and serves status.
 */
export interface ProjectionSnapshotEnvelope {
  readonly schema_version: 1;
  readonly descriptor_hash: string;
  readonly run_id: string;
  readonly revision_id: string;
  /** Writer epoch that saved this snapshot. */
  readonly epoch: number;
  /** seq of the last journal record reflected in this snapshot. */
  readonly saved_at_seq: number;
  readonly projection: GraphSchedulerProjection;
}

/** Load/save surface over `<runsRoot>/<run_id>/projection.json`. */
export interface ProjectionStore {
  /**
   * Persist atomically (temp file + rename). Throws when descriptor binding
   * mismatches a previously stored envelope for the same path.
   */
  save(envelope: ProjectionSnapshotEnvelope): Promise<void>;
  /** Returns null when no snapshot exists yet. Fail-closed on parse errors. */
  load(): Promise<ProjectionSnapshotEnvelope | null>;
}

// ---------------------------------------------------------------------------
// Node executors
// ---------------------------------------------------------------------------

/** Inputs handed to a NodeExecutor for one attempt of one executable node. */
export interface NodeExecutionContext {
  readonly descriptor: SealedGraphDescriptor;
  /** Narrowed executable node (kind agent|command) — never approval/join. */
  readonly node: Extract<GraphNode, { kind: ExecutableKind }>;
  readonly activation_id: string;
  readonly attempt_id: string;
  readonly attempt_no: number;
}

/** What an executor reports for one attempt. */
export interface NodeExecutionOutput {
  readonly outcome: "succeeded" | "failed";
  readonly output_summary?: string;
  readonly evidence_refs: readonly GraphEvidenceReference[];
  /** Idempotency key from effect_policy templates (command executor). */
  readonly external_idempotency_key?: string;
  /**
   * Required when the node's outgoing edges include conditional edges; the
   * runner feeds it to applyNodeResult. Must be a declared route.
   */
  readonly route?: string;
}

/** Executor for executable nodes (agent/command). Pure I/O boundary object. */
export interface NodeExecutor {
  kinds: readonly ExecutableKind[];
  execute(context: NodeExecutionContext): Promise<NodeExecutionOutput>;
}

// ---------------------------------------------------------------------------
// Human approval gate
// ---------------------------------------------------------------------------

/** One approval request surfaced to a HumanApprovalPrompter. */
export interface ApprovalRequest {
  readonly run_id: string;
  readonly node_id: string;
  readonly activation_id: string;
  readonly prompt_text: string;
}

/** Asks a human for an approval decision; injected into the runner for tests. */
export interface HumanApprovalPrompter {
  prompt(request: ApprovalRequest): Promise<GraphApprovalDecision["decision"]>;
}

/** Consumes progress events; progress.ts renders ASCII, tests collect events. */
export interface ProgressReporter {
  onEvent(event: RuntimeProgressEvent): void;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/** ASCII progress events; progress.ts renders these, runner emits them. */
export type RuntimeProgressEvent =
  | { readonly type: "run_started"; readonly run_id: string; readonly goal: string }
  | { readonly type: "replayed"; readonly records: number; readonly epoch: number }
  | { readonly type: "activation_started"; readonly node_id: string; readonly attempt_no: number }
  | { readonly type: "node_result"; readonly node_id: string; readonly outcome: "succeeded" | "failed" | "approved" | "denied" | "join_resolved" }
  | { readonly type: "run_ended"; readonly terminal: "succeeded" | "failed"; readonly summary: string };

/** Injectable I/O + collaborators for the runner (tests pass fakes). */
export interface RunOptions {
  /** Default: `.omc/graph-runs` under cwd. */
  readonly runsRoot?: string;
  readonly executors: readonly NodeExecutor[];
  readonly prompter: HumanApprovalPrompter;
  readonly reporter?: ProgressReporter;
  readonly signal?: AbortSignal;
}

/** Terminal result of a completed graph run. */
export interface RunResult {
  readonly terminal: "succeeded" | "failed";
  readonly run_id: string;
  readonly descriptor_hash: string;
  readonly epoch: number;
  readonly exit_code: ExitCode;
}

/**
 * Normative process exit codes for `omc graph run`. The CLI maps runner
 * outcomes to these; e2e tests assert on them.
 */
export const EXIT_CODES = {
  OK: 0,
  FAILED_TERMINAL: 1,
  FENCED_OUT: 19,
  CORRUPT_JOURNAL: 20,
  DESCRIPTOR_MISMATCH: 21,
} as const;

export type ExitCode =
  (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
