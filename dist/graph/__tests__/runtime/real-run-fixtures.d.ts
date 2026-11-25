/**
 * Runs for the tests of `omc graph gc` and `omc graph status`, written the way the runtime writes them: the descriptor
 * is sealed, every journal record comes out of the scheduler (so it carries its request fingerprint) and is signed
 * with the journal fingerprint, and the snapshot is the envelope the runner saves after each record. They are built
 * synchronously and without a process, so a test can make many of them. A forged or damaged file is made by editing
 * what this module wrote.
 */
import type { GraphSchedulerProjection, SealedGraphDescriptor } from "../../types.js";
/**
 * What the run looks like:
 *   succeeded  both steps ran; the terminal step succeeded with evidence
 *   failed     the first step failed; nothing else can run
 *   ready      the first step ran; the second is ready to start (a run stopped between two steps)
 *   approval   the first step ran; a human approval gate is ready
 *   denied     the gate was denied; nothing else can run
 *   initial    nothing is committed yet: the descriptor and the initial snapshot only
 */
export type RealRunKind = "succeeded" | "failed" | "ready" | "approval" | "denied" | "initial";
export interface RealRun {
    readonly dir: string;
    readonly sealed: SealedGraphDescriptor;
    /** The text of journal.jsonl, one signed record per line. */
    readonly journal: string;
    readonly records: readonly Record<string, any>[];
    readonly projection: GraphSchedulerProjection;
    /** The snapshot envelope as the runner saves it after the last record. */
    readonly envelope: Record<string, any>;
}
/** Writes a run of the given kind under `root/<runId>` and returns what was written. `epoch` is the writer epoch of the records. */
export declare function writeRealRun(root: string, runId: string, kind: RealRunKind, epoch?: number): RealRun;
//# sourceMappingURL=real-run-fixtures.d.ts.map