/**
 * Metadata for a discovered transcript file
 */
export interface TranscriptFile {
    projectPath: string;
    projectDir: string;
    sessionId: string;
    filePath: string;
    fileSize: number;
    modifiedTime: Date;
}
/**
 * Result of scanning for transcripts
 */
export interface ScanResult {
    transcripts: TranscriptFile[];
    totalSize: number;
    projectCount: number;
}
/**
 * Options for scanning transcripts
 */
export interface ScanOptions {
    projectFilter?: string;
    minDate?: Date;
}
/**
 * Decode project directory name back to original path.
 *
 * The encoding scheme used by Claude Code is lossy - it converts all path
 * separators (/ or \) to dashes (-), but legitimate dashes in directory names
 * also become dashes, making them indistinguishable.
 *
 * Encoding patterns:
 *   - Unix: "/home/user/project" → "-home-user-project"
 *   - Windows: "C:\Users\user\project" → "C--Users-user-project"
 *
 * Strategy:
 * 1. Detect if it's a Windows or Unix encoded path
 * 2. Try simple decode (all dashes -> slashes) and check if path exists
 * 3. If not, try to reconstruct by checking filesystem for partial matches
 * 4. Fall back to simple decode if nothing else works
 *
 * @internal Exported for testing
 */
export declare function decodeProjectPath(dirName: string): string;
/**
 * Scan for all transcript files in ~/.claude/projects/
 */
export declare function scanTranscripts(options?: ScanOptions): Promise<ScanResult>;
//# sourceMappingURL=transcript-scanner.d.ts.map