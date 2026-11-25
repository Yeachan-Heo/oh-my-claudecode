/**
 * Removal of a run for `omc graph gc`: ownership first, a second decision under the lock, an atomic move out of the
 * runs namespace, then a deletion of the moved tree that never follows a link. The rules and the safety notes are in
 * run-gc.ts.
 */
import { type FileIdentity, type OperationsFor } from "./run-gc-read.js";
export interface ScannedRun {
    readonly identity: FileIdentity;
    readonly cutoffMs: number;
    readonly epochFloor: number;
    /** Test-only interlocks: once the lock is held, and once the directory is open, each before the run is decided again. */
    readonly afterOwnership?: () => void;
    readonly afterHandle?: () => void;
    /** Test-only interlock: the decision reads under the lock are done; the name is not checked yet. */
    readonly afterReads?: () => void;
    /** Test-only interlock: after the name was checked for the last time, right before the directory is moved. */
    readonly beforeMove?: () => void;
    /** Test-only interlock: right after the directory was moved, before the moved directory is checked. */
    readonly afterMove?: () => void;
    /** Test-only interlock: the moved directory is checked, and is about to be renamed to its quarantine name. */
    readonly beforePromote?: () => void;
    /** Test-only: replaces the directory-relative operations of the platform (see OperationsFor). */
    readonly operationsFor?: OperationsFor;
}
export declare function removeTree(path: string, interlock?: {
    afterLstat?: (path: string) => void;
    beforeFinalRmdir?: () => void;
    operationsFor?: OperationsFor;
}, expected?: FileIdentity): void;
export declare function quarantineRun(realRoot: string, id: string, nowMs?: number, suffix?: string, scanned?: ScannedRun): string;
export declare function removeRun(realRoot: string, id: string, scanned?: ScannedRun): void;
//# sourceMappingURL=run-gc-remove.d.ts.map