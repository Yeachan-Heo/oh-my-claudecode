import * as nodeFs from 'node:fs';
import * as nativePath from 'node:path';
export declare const CLAUDE_MD_IMPORT_START = "<!-- OMC:IMPORT:START -->";
export declare const CLAUDE_MD_IMPORT_END = "<!-- OMC:IMPORT:END -->";
export declare const CLAUDE_MD_IMPORT_BLOCK = "<!-- OMC:IMPORT:START -->\n@CLAUDE-omc.md\n<!-- OMC:IMPORT:END -->\n";
export type ClaudeMdTransactionMode = 'local' | 'global-overwrite' | 'global-preserve';
export type ClaudeMdTransactionExitCode = 0 | 3 | 4 | 5 | 6;
/** Metadata returned to callers. Content bytes and temporary paths are deliberately private. */
export interface ClaudeMdOperation {
    path: string;
    type: 'write' | 'delete';
    existedBefore: boolean;
}
export interface ClaudeMdTransactionResult {
    ok: boolean;
    exitCode: ClaudeMdTransactionExitCode;
    mode: ClaudeMdTransactionMode;
    operations: ClaudeMdOperation[];
    completedOperations: ClaudeMdOperation[];
    backups: string[];
    createdPaths: string[];
    deletedPaths: string[];
    mutatedPaths: string[];
    removedRanges: Array<{
        start: number;
        end: number;
    }>;
    removedVariants: string[];
    warnings: string[];
    error?: string;
    failedPhase?: 'validation' | 'backup' | 'mutation' | 'rollback';
    failedPath?: string;
    rollback: Array<{
        path: string;
        ok: boolean;
        error?: string;
    }>;
    tempCleanup: Array<{
        path: string;
        ok: boolean;
        error?: string;
    }>;
}
export interface ClaudeMdTransactionFs {
    existsSync: typeof nodeFs.existsSync;
    lstatSync: typeof nodeFs.lstatSync;
    mkdirSync: typeof nodeFs.mkdirSync;
    openSync: typeof nodeFs.openSync;
    closeSync: typeof nodeFs.closeSync;
    readFileSync: typeof nodeFs.readFileSync;
    renameSync: typeof nodeFs.renameSync;
    rmSync: typeof nodeFs.rmSync;
    unlinkSync: typeof nodeFs.unlinkSync;
    writeFileSync: typeof nodeFs.writeFileSync;
}
export interface ClaudeMdTransactionRequest {
    mode: ClaudeMdTransactionMode;
    root: string;
    source: string;
    sourceRoot?: string;
    version?: string;
    /** A coordinator-verified canonical buffer. This prevents a second source read/swap. */
    sourceBytes?: Buffer;
    /** Test-only synchronous filesystem seam. */
    fs?: ClaudeMdTransactionFs;
}
/** Decodes only valid UTF-8 without stripping a leading byte-order mark. */
export declare function decodeClaudeMdUtf8(bytes: Buffer, path: string): string;
/**
 * Returns whether candidate is a strict lexical child of root using the supplied host path implementation.
 * The injectable path implementation exists solely for platform-independent lexical tests.
 */
export declare function isStrictChildPath(root: string, candidate: string, path?: Pick<typeof nativePath, 'isAbsolute' | 'relative' | 'resolve'>): boolean;
export declare function validateRootedRegularFile(root: string, path: string, allowAbsent?: boolean, fs?: ClaudeMdTransactionFs): string;
export declare function executeClaudeMdTransaction(request: ClaudeMdTransactionRequest): ClaudeMdTransactionResult;
//# sourceMappingURL=claude-md-transaction.d.ts.map