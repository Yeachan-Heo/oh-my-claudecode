/**
 * Shared MCP execution helpers
 *
 * Pure helper functions used by both codex-core.ts and gemini-core.ts
 * to eliminate duplicated stdout truncation and output file writing logic.
 */
import { existsSync, mkdirSync, writeFileSync, realpathSync, unlinkSync } from 'fs';
import { dirname, resolve, relative, isAbsolute, basename, join } from 'path';
import { getMcpConfig } from './mcp-config.js';
export const TRUNCATION_MARKER = '\n\n[OUTPUT TRUNCATED: exceeded 10MB limit]';
/**
 * Error code for output path outside working directory
 */
export const E_PATH_OUTSIDE_WORKDIR_OUTPUT = 'E_PATH_OUTSIDE_WORKDIR_OUTPUT';
/**
 * Creates a streaming stdout collector that accumulates output up to maxBytes.
 * Once the limit is exceeded, further chunks are ignored and a truncation
 * marker is appended exactly once.
 */
export function createStdoutCollector(maxBytes) {
    let buffer = '';
    let byteCount = 0;
    let truncated = false;
    return {
        append(chunk) {
            if (truncated)
                return;
            byteCount += chunk.length;
            if (byteCount > maxBytes) {
                const overshoot = byteCount - maxBytes;
                buffer += chunk.slice(0, Math.max(0, chunk.length - overshoot));
                buffer += TRUNCATION_MARKER;
                truncated = true;
            }
            else {
                buffer += chunk;
            }
        },
        toString() {
            return buffer;
        },
        get isTruncated() {
            return truncated;
        },
    };
}
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
export function safeWriteOutputFile(outputFile, content, baseDirReal, logPrefix = '[mcp]') {
    const config = getMcpConfig();
    const policy = config.outputPathPolicy;
    const outputPath = resolve(baseDirReal, outputFile);
    const relOutput = relative(baseDirReal, outputPath);
    // Check if path is outside working directory
    const isOutsideWorkdir = relOutput.startsWith('..') || isAbsolute(relOutput);
    if (isOutsideWorkdir) {
        if (policy === 'strict') {
            const errorToken = E_PATH_OUTSIDE_WORKDIR_OUTPUT;
            const errorMessage = `${errorToken}: output_file '${outputFile}' resolves outside working_directory '${baseDirReal}' and was rejected by policy '${policy}'.
Requested: ${outputFile}
Working directory: ${baseDirReal}
Suggested: use '${join(config.outputRedirectDir, basename(outputFile))}' or set OMC_MCP_OUTPUT_PATH_POLICY=redirect_output`;
            console.warn(`${logPrefix} ${errorMessage}`);
            return { success: false, errorToken, errorMessage };
        }
        // redirect_output policy: redirect to configured directory
        const redirectDir = isAbsolute(config.outputRedirectDir)
            ? config.outputRedirectDir
            : resolve(baseDirReal, config.outputRedirectDir);
        const safeOutputPath = join(redirectDir, basename(outputFile));
        const safeRelPath = relative(baseDirReal, safeOutputPath);
        console.warn(`${logPrefix} output_file '${outputFile}' resolves outside working directory, redirecting to '${safeRelPath}' per policy '${policy}'`);
        try {
            if (!existsSync(redirectDir)) {
                mkdirSync(redirectDir, { recursive: true });
            }
            writeFileSync(safeOutputPath, content, 'utf-8');
            // Verify written file didn't escape via symlink
            try {
                const writtenReal = realpathSync(safeOutputPath);
                const relWritten = relative(baseDirReal, writtenReal);
                if (relWritten.startsWith('..') || isAbsolute(relWritten)) {
                    // Written file escaped boundary via symlink - remove and error
                    try {
                        unlinkSync(safeOutputPath);
                    }
                    catch { }
                    const errorToken = E_PATH_OUTSIDE_WORKDIR_OUTPUT;
                    const errorMessage = `${errorToken}: output file '${outputFile}' resolved to '${writtenReal}' outside working_directory '${baseDirReal}' via symlink.\nSuggested: remove the symlink and retry`;
                    console.warn(`${logPrefix} ${errorMessage}`);
                    return { success: false, errorToken, errorMessage };
                }
            }
            catch { }
            return { success: true, actualPath: safeOutputPath };
        }
        catch (err) {
            const errorToken = 'E_WRITE_FAILED';
            const errorMessage = `${errorToken}: Failed to write redirected output file: ${err.message}`;
            console.warn(`${logPrefix} ${errorMessage}`);
            return { success: false, errorToken, errorMessage };
        }
    }
    try {
        const outputDir = dirname(outputPath);
        if (!existsSync(outputDir)) {
            const relDir = relative(baseDirReal, outputDir);
            if (relDir.startsWith('..') || isAbsolute(relDir)) {
                const errorToken = E_PATH_OUTSIDE_WORKDIR_OUTPUT;
                const errorMessage = `${errorToken}: output_file directory '${outputDir}' is outside working_directory '${baseDirReal}'.
Requested: ${outputFile}
Working directory: ${baseDirReal}
Suggested: place the output file within the working directory or set working_directory to a common ancestor`;
                console.warn(`${logPrefix} ${errorMessage}`);
                return { success: false, errorToken, errorMessage };
            }
            mkdirSync(outputDir, { recursive: true });
        }
        let outputDirReal;
        try {
            outputDirReal = realpathSync(outputDir);
        }
        catch {
            const errorToken = 'E_PATH_RESOLUTION_FAILED';
            const errorMessage = `${errorToken}: Failed to resolve output directory '${outputDir}'.
Requested: ${outputFile}
Working directory: ${baseDirReal}
Suggested: ensure the output directory exists and is accessible`;
            console.warn(`${logPrefix} ${errorMessage}`);
            return { success: false, errorToken, errorMessage };
        }
        if (outputDirReal) {
            const relDirReal = relative(baseDirReal, outputDirReal);
            if (relDirReal.startsWith('..') || isAbsolute(relDirReal)) {
                const errorToken = E_PATH_OUTSIDE_WORKDIR_OUTPUT;
                const errorMessage = `${errorToken}: output_file directory '${outputDir}' resolves outside working_directory '${baseDirReal}'.
Requested: ${outputFile}
Working directory: ${baseDirReal}
Suggested: place the output file within the working directory or set working_directory to a common ancestor`;
                console.warn(`${logPrefix} ${errorMessage}`);
                return { success: false, errorToken, errorMessage };
            }
            const safePath = join(outputDirReal, basename(outputPath));
            writeFileSync(safePath, content, 'utf-8');
            // Verify written file didn't escape via symlink
            try {
                const writtenReal = realpathSync(safePath);
                const relWritten = relative(baseDirReal, writtenReal);
                if (relWritten.startsWith('..') || isAbsolute(relWritten)) {
                    // Written file escaped boundary via symlink - remove and error
                    try {
                        unlinkSync(safePath);
                    }
                    catch { }
                    const errorToken = E_PATH_OUTSIDE_WORKDIR_OUTPUT;
                    const errorMessage = `${errorToken}: output file '${outputFile}' resolved to '${writtenReal}' outside working_directory '${baseDirReal}' via symlink.\nSuggested: remove the symlink and retry`;
                    console.warn(`${logPrefix} ${errorMessage}`);
                    return { success: false, errorToken, errorMessage };
                }
            }
            catch { }
            return { success: true, actualPath: safePath };
        }
        return { success: true, actualPath: outputPath };
    }
    catch (err) {
        const errorToken = 'E_WRITE_FAILED';
        const errorMessage = `${errorToken}: Failed to write output file '${outputFile}': ${err.message}`;
        console.warn(`${logPrefix} ${errorMessage}`);
        return { success: false, errorToken, errorMessage };
    }
}
//# sourceMappingURL=shared-exec.js.map