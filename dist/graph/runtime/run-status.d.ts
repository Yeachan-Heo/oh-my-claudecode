/**
 * Read-only status of one graph run, for `omc graph status <run_id>`.
 *
 * Reads only `<runs-root>/<run_id>/descriptor.json`, `projection.json` and `journal.jsonl`. The run state is derived,
 * because the graph runtime writes no terminal record to disk, and it is derived the way the runtime derives it: the
 * journal is replayed (classifyRunFiles in run-state.ts, the same function `omc graph gc` uses, built on the
 * runtime's replay fold) and `projection.json` is a status cache that is never trusted for the verdict. The states:
 *   succeeded    the scheduler success predicate holds after the replay;
 *   failed       no activation can be started, resolved or approved and the run did not succeed (the runtime ends
 *                such a run as failed, for example after a failed step or a denied approval);
 *   in_progress  an activation is ready, including a run interrupted by a signal (its last attempt was never
 *                committed, so it is ready again);
 *   missing      there is no run directory (exit 2);
 *   unreadable   the directory exists but its files are not a run the runtime could resume (exit 4): no descriptor, a
 *                descriptor of another run, a partial last journal line (a file still being written), a journal with
 *                a gap, another run's records or a record that fails the replay, or a descriptor with neither a
 *                committed record nor the initial snapshot. A run whose snapshot is lost, stale or restored is
 *                reported from its journal.
 * Every activation counts, not only the latest one of each node. A node that never got an activation (for example the
 * step after a failed step) is not listed.
 *
 * The three files are read through one open handle on the run directory (the runtime's own directory-relative
 * operations, on Linux and on macOS with the native module), so a directory that is swapped for a link or for another
 * directory after the check cannot redirect the reads, and the name must still be the same directory (device and
 * inode) after the reads. Where the runtime has no such primitive the files are read by path, with the same check of
 * the directory before and after.
 */
import { type DirectoryOperations } from "./contained-fd.js";
export declare const RUN_STATUS_EXIT_CODES: {
    readonly succeeded: 0;
    readonly failed: 1;
    readonly in_progress: 3;
    readonly missing: 2;
    readonly usage: 2;
    readonly unreadable: 4;
};
export interface RunStatusOptions {
    readonly runId: string;
    /** Runs root directory; the CLI passes `.omc/graph-runs` when `--runs-root` is not given. */
    readonly runsRoot: string;
    /** Test-only hooks: they run inside the window between the check of the run directory and its use, or replace the operations of the platform. */
    readonly interlock?: {
        /** After the run directory was checked and before it is opened. */
        readonly afterDirectoryCheck?: () => void;
        /** After the files were read and before the directory is checked again. */
        readonly afterRead?: () => void;
        /** The directory is open and is the one that was checked; no file is read yet. */
        readonly afterOpen?: () => void;
        /** Replaces the directory-relative operations of the platform; null stands for a platform that has none. */
        readonly operationsFor?: (fd: number) => DirectoryOperations | null;
    };
}
export interface RunStatusOutcome {
    /** Exit code of the command (see RUN_STATUS_EXIT_CODES). */
    readonly exitCode: number;
    /** One JSON object followed by a newline, for stdout. Empty for usage errors. */
    readonly stdout: string;
    /** Usage message for stderr; empty unless the arguments were refused. */
    readonly stderr: string;
}
/** Derives the status of one run. Read-only: nothing on disk is created or changed. */
export declare function readRunStatus(options: RunStatusOptions): RunStatusOutcome;
//# sourceMappingURL=run-status.d.ts.map