/**
 * Runtime runner: the orchestration loop binding the pure Graph Core
 * scheduler to disk-backed journal/fence/projection-store and injected
 * executors.
 *
 * Replay contract (AC-3/AC-11b): the journal is the source of truth; on
 * resume, records are folded through the same scheduler entrypoints used
 * live. Synthetic identities are regenerated deterministically from
 * projection counters and the committed record fields, so the folded
 * projection equals the live one bit-for-bit under canonicalJson equality,
 * including embedded request fingerprints.
 */
import type { JournalRecord, RunOptions, RunResult } from "./types.js";
import type { GraphSchedulerProjection, SealedGraphDescriptor } from "../types.js";
/** The projection of a run before any record is committed: the entry activations are ready. */
export declare function initialRunProjection(stored: SealedGraphDescriptor): GraphSchedulerProjection;
/**
 * Replays committed journal records over `projection`, the way a resume does. Epoch provenance: takeovers only ever
 * raise the epoch, so committed history must be non-decreasing and must never exceed `epochCeiling`, the epoch the
 * resuming process acquired; anything else is forged or stale-writer provenance. Each record is bound to the
 * descriptor, passes its envelope and request fingerprints and folds through the scheduler. Throws
 * GraphSchedulerError for a record that does not.
 */
export declare function foldJournalRecords(stored: SealedGraphDescriptor, projection: GraphSchedulerProjection, records: readonly JournalRecord[], epochCeiling: number): GraphSchedulerProjection;
/**
 * How a run ends when nothing is in flight: `succeeded` when the scheduler success rule holds, `failed` when no
 * activation can be started, resolved or approved, otherwise `open`. `excluded` names the ready executable
 * activations that must not count as work (in flight, or out of attempts). After a replay an activation whose
 * attempts are used up is already terminal (scheduler: the final-budget release), so a status or a gc pass that has
 * nothing in flight excludes none.
 */
export declare function idleOutcome(sealed: SealedGraphDescriptor, projection: GraphSchedulerProjection, excluded: (activationId: string) => boolean): "succeeded" | "failed" | "open";
/**
 * Runs one sealed graph to a terminal outcome.
 *
 * Exit mapping (normative, EXIT_CODES): FenceError busy/fenced_out -> 19,
 * JournalCorruptionError -> 20, descriptor mismatch -> 21, graph-terminal
 * failure -> 1, success -> 0. Mapped failures keep the lock file (abnormal
 * exit); only normal termination releases it — stale reap covers crashes.
 */
export declare function runGraph(sealed: SealedGraphDescriptor, options: RunOptions): Promise<RunResult>;
//# sourceMappingURL=runner.d.ts.map