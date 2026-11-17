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
import type { RunOptions, RunResult } from "./types.js";
import type { SealedGraphDescriptor } from "../types.js";
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