/**
 * Ownership of a run directory for `omc graph gc`: the single-writer fence the runtime uses, and the one way gc and
 * repair touch the files of a run under ownership (through the open run directory, whose identity is the scanned
 * one). The rules and the safety notes are in run-gc.ts.
 */
import type { DirectoryOperations } from "./contained-fd.js";
import { FileOwnershipFence } from "./fence.js";
import { type FileIdentity, type OperationsFor, type TreeReader } from "./run-gc-read.js";
export declare function assertIdentity(actual: FileIdentity, expected: FileIdentity | undefined, what: string): void;
export declare function takeOwnership(runDir: string, refusal: string, expected?: FileIdentity): {
    fence: FileOwnershipFence;
    epoch: number;
};
export interface AnchoredRun {
    /** Operations relative to the open directory (every open adds O_NOFOLLOW). */
    readonly operations: DirectoryOperations;
    /** The files of the directory, read through `operations`. */
    readonly reader: TreeReader;
    /** Throws unless the name of the run still is the directory that is open (device and inode). */
    assertNamed(): void;
}
export declare function withRunDirectory<T>(runDir: string, expected: FileIdentity, operationsFor: OperationsFor, action: (run: AnchoredRun) => T, checkAfter?: boolean): T;
//# sourceMappingURL=run-gc-owner.d.ts.map