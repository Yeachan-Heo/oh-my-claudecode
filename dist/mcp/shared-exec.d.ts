/**
 * Shared MCP execution helpers
 *
 * Pure helper functions used by both codex-core.ts and gemini-core.ts
 * to eliminate duplicated stdout truncation and output file writing logic.
 */
import { type OutputPathPolicy } from './mcp-config.js';
export declare const TRUNCATION_MARKER = "\n\n[OUTPUT TRUNCATED: exceeded 10MB limit]";
/**
 * Error code for output path outside working directory
 */
export declare const E_PATH_OUTSIDE_WORKDIR_OUTPUT = "E_PATH_OUTSIDE_WORKDIR_OUTPUT";
/**
 * Creates a streaming stdout collector that accumulates output up to maxBytes.
 * Once the limit is exceeded, further chunks are ignored and a truncation
 * marker is appended exactly once.
 */
export declare function createStdoutCollector(maxBytes: number): {
    append(chunk: string): void;
    toString(): string;
    readonly isTruncated: boolean;
};
/**
 * Result type for safeWriteOutputFile
 */
export type SafeWriteResult = {
    success: true;
    actualPath?: string;
    errorToken?: never;
    errorMessage?: never;
} | {
    success: false;
    errorToken: string;
    errorMessage: string;
    actualPath?: never;
};
export type { OutputPathPolicy };
/**
 * Safely write content to an output file, ensuring the path stays within
 * the base directory boundary (symlink-safe).
 *
 * @param outputFile - The requested output file path (relative or absolute)
 * @param content - Content to write
 * @param baseDirReal - The resolved working directory path
 * @param logPrefix - Prefix for log messages
 * @param policy - Policy for handling paths outside working directory ('strict' or 'redirect_output')
 * @returns A SafeWriteResult indicating success or failure with detailed error info.
 */
export declare function safeWriteOutputFile(outputFile: string, content: string, baseDirReal: string, logPrefix?: string): SafeWriteResult;
//# sourceMappingURL=shared-exec.d.ts.map