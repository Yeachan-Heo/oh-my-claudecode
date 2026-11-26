/**
 * The state of one graph run, derived the way the runtime derives it, for `omc graph status` and `omc graph gc`.
 *
 * The runtime keeps no status field, and it never trusts `projection.json`: a resume folds every record of the journal
 * over the entry projection (runner.ts, the replay fold) and the snapshot is only a status cache. This module does the
 * same from the text of a run's files, with the functions the runtime uses: the descriptor parse, the journal parse,
 * the replay fold (descriptor binding, epoch provenance, envelope and request fingerprints, scheduler transitions) and
 * the idle outcome rule. A run is one of:
 *
 *   succeeded    the scheduler success rule holds after the replay;
 *   failed       no activation can be started, resolved or approved, and the run did not succeed;
 *   in_progress  an activation is ready (an attempt that was running when the process stopped is ready again after
 *                a replay, because an attempt is committed only with its result);
 *   unreadable   the files do not make a run the runtime could resume: no descriptor, a descriptor of another run, a
 *                journal that is torn or corrupt, a record that fails the fold, or a descriptor with neither a
 *                committed record nor the initial snapshot.
 *
 * `missing` is not decided here: it means that the run directory does not exist, which the caller knows.
 *
 * The snapshot never decides a verdict. It is read only for a descriptor with an empty journal, where the replay has
 * nothing to fold: the initial snapshot (`saved_at_seq` -1, bound to the descriptor, run and revision) is the evidence
 * that the run was initialized and has not committed a record yet. A lost, restored or corrupt snapshot beside a
 * journal that replays does not change the verdict. One exception comes before the replay, from the readers of the
 * files: a projection.json that is a link, a FIFO or another file that is not a regular file is refused when the files
 * are read (status: unreadable, gc: unknown), because nothing is read through it.
 */
import type { GraphSchedulerProjection, SealedGraphDescriptor } from "../types.js";
import type { JournalRecord } from "./types.js";
/** Text of the three files of a run; null for a file that does not exist. */
export interface RunFileTexts {
    readonly descriptor: string | null;
    readonly journal: string | null;
    readonly projection: string | null;
}
export type UnreadableReason = "descriptor-missing" | "descriptor-malformed" | "descriptor-not-of-run" | "journal-corrupt" | "replay-rejected" | "no-history";
export type RunClassification = {
    readonly state: "unreadable";
    readonly reason: UnreadableReason;
    readonly detail: string;
} | {
    readonly state: "succeeded" | "failed" | "in_progress";
    readonly descriptor: SealedGraphDescriptor;
    /** The replayed projection, not the snapshot. */
    readonly projection: GraphSchedulerProjection;
    readonly records: readonly JournalRecord[];
    /** An approval activation is ready (only for an in_progress run). */
    readonly approvalPending: boolean;
};
/**
 * Classifies the run `runId` from the text of its files. `epochCeiling` is the highest writer epoch a record may
 * carry: pass the epoch the caller has acquired for the run (the runtime's own bound on resume); without it the
 * epochs must only be non-decreasing. Never throws for the content of a file.
 */
export declare function classifyRunFiles(runId: string, files: RunFileTexts, epochCeiling?: number): RunClassification;
//# sourceMappingURL=run-state.d.ts.map