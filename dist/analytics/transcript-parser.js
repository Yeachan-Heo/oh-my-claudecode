import * as fs from 'fs';
import * as readline from 'readline';
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
export async function* parseTranscript(filePath, options = {}) {
    const { signal, onParseError } = options;
    // Check if file exists
    if (!fs.existsSync(filePath)) {
        throw new Error(`Transcript file not found: ${filePath}`);
    }
    const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity // Treat \r\n as single line break
    });
    // Handle abort signal
    const abortHandler = () => {
        rl.close();
        fileStream.destroy();
    };
    if (signal) {
        signal.addEventListener('abort', abortHandler);
    }
    try {
        for await (const line of rl) {
            // Check abort before processing each line
            if (signal?.aborted) {
                break;
            }
            // Skip empty lines
            if (!line.trim()) {
                continue;
            }
            try {
                const entry = JSON.parse(line);
                yield entry;
            }
            catch (error) {
                // Handle malformed JSON gracefully
                const parseError = error instanceof Error ? error : new Error(String(error));
                if (onParseError) {
                    onParseError(line, parseError);
                }
                else {
                    // Default: log warning and skip line
                    console.warn(`[transcript-parser] Skipping malformed line: ${parseError.message}`);
                }
            }
        }
    }
    finally {
        // Clean up
        if (signal) {
            signal.removeEventListener('abort', abortHandler);
        }
        rl.close();
        fileStream.destroy();
    }
}
/**
 * Load all entries from a transcript file into memory.
 * Use this for smaller files or when you need all entries at once.
 * For large files, prefer the streaming `parseTranscript()` generator.
 *
 * @param filePath - Path to the transcript JSONL file
 * @param options - Parsing options
 * @returns Array of all transcript entries
 */
export async function loadTranscript(filePath, options = {}) {
    const entries = [];
    for await (const entry of parseTranscript(filePath, options)) {
        entries.push(entry);
    }
    return entries;
}
//# sourceMappingURL=transcript-parser.js.map