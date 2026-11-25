/**
 * What `omc graph gc` and `omc graph status` read from one run directory: the lease in owner.lock, the files of the
 * run (by name for the scan, relative to the open directory under ownership), and the verdict on a run. Reads only;
 * nothing here changes a run. The rules and the safety notes are in run-gc.ts.
 */
import type { DirectoryOperations } from "./contained-fd.js";
export declare const LOCK_FILE_NAME = "owner.lock";
export declare const JOURNAL_FILE_NAME = "journal.jsonl";
export declare const TORN_COPY_PREFIX = "journal.jsonl.torn-";
export declare const KEPT_JOURNAL_PREFIX = "journal.jsonl.before-repair-";
export declare const QUARANTINE_PREFIX = ".deleted-";
export declare function quarantineNameFor(id: string, nowMs: number, suffix: string, identity: FileIdentity): string;
export declare function quarantineIdentityOf(name: string): FileIdentity | null;
export declare const STAGING_PREFIX = ".moving-";
export declare const NOFOLLOW: number;
export declare const NONBLOCK: number;
export interface LeaseState {
    readonly held: boolean;
    readonly reason: string;
}
export interface FileIdentity {
    readonly dev: number;
    readonly ino: number;
}
export declare function leaseOf(runDir: string): LeaseState;
export declare function epochFloorOf(runDir: string): number;
export type OperationsFor = (fd: number) => DirectoryOperations | null;
export declare const NO_OPERATIONS = "this platform has no directory-relative file operations; the run was left unchanged";
export interface TreeReader {
    names(): string[];
    /** The entry itself, never what a link points to. */
    stat(name: string): {
        dev: number;
        ino: number;
        mtimeMs: number;
        size: number;
        isFile(): boolean;
        isDirectory(): boolean;
    };
    /** One regular file, read without following a link. */
    read(name: string): Buffer;
    /** Runs `action` on a subdirectory that is the one `seen` describes: a directory swapped for a link or another directory since is refused. */
    enter<T>(name: string, seen: {
        dev: number;
        ino: number;
    }, action: (inner: TreeReader) => T): T;
}
export declare function byName(dir: string): TreeReader;
export declare function relativeTo(operations: DirectoryOperations, operationsFor: OperationsFor): TreeReader;
export declare function measureTree(reader: TreeReader, topMtimeMs: number, ownedByFence: boolean): {
    newestMs: number;
    bytes: number;
};
export declare function measureRun(runDir: string): {
    newestMs: number;
    bytes: number;
    identity: FileIdentity;
};
export declare function splitTornTail(bytes: Buffer): {
    complete: Buffer;
    tail: Buffer;
};
export declare function classifyRun(runDir: string, runId: string, epochCeiling?: number): {
    state: string;
    reason: string;
};
export interface Verdict {
    decision: "keep" | "delete";
    reason: string;
    state: string | null;
    torn: boolean;
}
export declare function judgeRun(reader: TreeReader, id: string, newestMs: number, cutoffMs: number, epochCeiling?: number): Verdict;
//# sourceMappingURL=run-gc-read.d.ts.map