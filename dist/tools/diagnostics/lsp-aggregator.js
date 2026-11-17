/**
 * LSP Aggregator - Fallback strategy for directory diagnostics
 *
 * When tsc is not available or not suitable, iterate through files
 * and collect LSP diagnostics for each.
 */
import { readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import { lspClientManager, getServerForFile } from '../lsp/index.js';
import { LSP_DIAGNOSTICS_WAIT_MS } from './index.js';
export const LSP_DIAGNOSTICS_CONCURRENCY = 8;
async function mapWithConcurrency(items, concurrency, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;
    async function worker() {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            results[index] = await mapper(items[index]);
        }
    }
    const workerCount = Math.min(concurrency, items.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
}
/**
 * Recursively find files with given extensions
 */
function findFiles(directory, extensions, ignoreDirs = []) {
    const results = [];
    const ignoreDirSet = new Set(ignoreDirs);
    function walk(dir) {
        try {
            const entries = readdirSync(dir).sort();
            for (const entry of entries) {
                const fullPath = join(dir, entry);
                try {
                    const stat = statSync(fullPath);
                    if (stat.isDirectory()) {
                        // Skip ignored directories
                        if (!ignoreDirSet.has(entry)) {
                            walk(fullPath);
                        }
                    }
                    else if (stat.isFile()) {
                        const ext = extname(fullPath);
                        if (extensions.includes(ext)) {
                            results.push(fullPath);
                        }
                    }
                }
                catch (_error) {
                    // Skip files/dirs we can't access
                    continue;
                }
            }
        }
        catch (_error) {
            // Skip directories we can't read
            return;
        }
    }
    walk(directory);
    return results;
}
/**
 * Run LSP diagnostics on all TypeScript/JavaScript files in a directory
 * @param directory - Project directory to scan
 * @param extensions - File extensions to check (default: ['.ts', '.tsx', '.js', '.jsx'])
 * @returns Aggregated diagnostics from all files
 */
export async function runLspAggregatedDiagnostics(directory, extensions = ['.ts', '.tsx', '.js', '.jsx']) {
    // Find all matching files
    const files = findFiles(directory, extensions, ['node_modules', 'dist', 'build', '.git']);
    const allDiagnostics = [];
    const skippedFiles = [];
    const installHintSet = new Set();
    const fileResults = await mapWithConcurrency(files, LSP_DIAGNOSTICS_CONCURRENCY, async (file) => {
        // Guards future callers passing custom extensions with no registered LSP; redundant under default extension list.
        if (!getServerForFile(file)) {
            return {
                file,
                skippedReason: 'no language server registered for extension',
            };
        }
        try {
            const diagnostics = await lspClientManager.runWithClientLease(file, async (client) => {
                return client.withOpenDocument(file, async () => {
                    if (client.supportsPullDiagnostics) {
                        return client.pullDiagnostics(file);
                    }
                    // Wait for the server to publish diagnostics via textDocument/publishDiagnostics.
                    // The timeout prevents a server that omits the notification from blocking a worker.
                    await client.waitForDiagnostics(file, LSP_DIAGNOSTICS_WAIT_MS);
                    return client.getDiagnostics(file);
                });
            });
            return { file, diagnostics };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { file, skippedReason: message };
        }
    });
    let filesChecked = 0;
    for (const result of fileResults) {
        if (result.diagnostics) {
            filesChecked++;
            for (const diagnostic of result.diagnostics) {
                allDiagnostics.push({
                    file: result.file,
                    diagnostic
                });
            }
            continue;
        }
        const message = result.skippedReason ?? 'unknown LSP diagnostics failure';
        // Keep the missing-server header literal in formatLspResult in sync.
        const match = message.match(/^Language server '([^']+)' not found\.\nInstall with: (.+)$/s);
        if (match) {
            installHintSet.add(match[2].trim());
            skippedFiles.push({
                file: result.file,
                reason: `missing language server: ${match[1]}`
            });
        }
        else {
            skippedFiles.push({ file: result.file, reason: message });
        }
    }
    // Count errors and warnings
    const errorCount = allDiagnostics.filter(d => d.diagnostic.severity === 1).length;
    const warningCount = allDiagnostics.filter(d => d.diagnostic.severity === 2).length;
    const installHints = Array.from(installHintSet);
    const allFilesSkipped = filesChecked === 0 && files.length > 0;
    return {
        success: errorCount === 0 && skippedFiles.length === 0 && !allFilesSkipped,
        diagnostics: allDiagnostics,
        errorCount,
        warningCount,
        filesChecked,
        skippedFiles,
        installHints,
    };
}
//# sourceMappingURL=lsp-aggregator.js.map