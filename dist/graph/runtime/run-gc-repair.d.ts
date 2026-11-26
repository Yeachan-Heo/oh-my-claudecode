/**
 * Repair of a torn last journal line for `omc graph gc`: the line is copied aside and the journal truncated, only
 * while this process owns the run. The rules and the safety notes are in run-gc.ts.
 */
import { type FileIdentity, type OperationsFor } from "./run-gc-read.js";
export interface RepairInterlock {
    /** The lock is held and no file has been opened yet. */
    readonly afterOwnership?: () => void;
    /** The run directory is open and its identity is checked; the journal is not opened yet. */
    readonly afterHandle?: () => void;
    /** The name was checked for the last time before the torn copy is created. */
    readonly beforeCopy?: () => void;
    /** The torn copy is written and synced; the shortened journal is not written yet. */
    readonly afterCopy?: () => void;
    /** The name was checked for the last time before the shortened journal is put in place of the journal. */
    readonly beforeTruncate?: () => void;
    /** The repair is done; the lock is not released yet. */
    readonly beforeRelease?: () => void;
    /** Test-only: replaces the directory-relative operations of the platform (see OperationsFor). */
    readonly operationsFor?: OperationsFor;
}
export declare function repairTornTail(runDir: string, nowMs: number, expected?: FileIdentity, interlock?: RepairInterlock): {
    repaired: boolean;
    copy: string | null;
};
//# sourceMappingURL=run-gc-repair.d.ts.map