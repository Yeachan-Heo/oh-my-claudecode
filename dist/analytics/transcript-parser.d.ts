import type { TranscriptEntry } from './types.js';
/**
 * Options for transcript parsing.
 */
export interface ParseTranscriptOptions {
    /**
     * AbortSignal to cancel parsing mid-stream.
     */
    signal?: AbortSignal;
    /**
     * Callback for parse errors (allows custom logging).
     */
    onParseError?: (line: string, error: Error) => void;
}
/**
 * Streaming JSONL parser for transcript files.
 * Parses line-by-line without loading the entire file into memory.
 *
 * @param filePath - Path to the transcript JSONL file
 * @param options - Parsing options including AbortSignal
 * @yields TranscriptEntry objects
 *
 * @example
 * ```typescript
 * const controller = new AbortController();
 * for await (const entry of parseTranscript('transcript.jsonl', { signal: controller.signal })) {
 *   console.log(entry);
 * }
 * ```
 */
export declare function parseTranscript(filePath: string, options?: ParseTranscriptOptions): AsyncGenerator<TranscriptEntry>;
/**
 * Load all entries from a transcript file into memory.
 * Use this for smaller files or when you need all entries at once.
 * For large files, prefer the streaming `parseTranscript()` generator.
 *
 * @param filePath - Path to the transcript JSONL file
 * @param options - Parsing options
 * @returns Array of all transcript entries
 */
export declare function loadTranscript(filePath: string, options?: ParseTranscriptOptions): Promise<TranscriptEntry[]>;
//# sourceMappingURL=transcript-parser.d.ts.map