/**
 * Directory Diagnostics - Project-level QA enforcement
 *
 * Provides dual strategy for checking TypeScript/JavaScript projects:
 * 1. Primary: tsc --noEmit (fast, comprehensive)
 * 2. Fallback: LSP iteration (when tsc not available)
 */
import { existsSync } from 'fs';
import { join } from 'path';
import { runTscDiagnostics } from './tsc-runner.js';
import { runLspAggregatedDiagnostics } from './lsp-aggregator.js';
import { formatDiagnostics } from '../lsp/utils.js';
export const LSP_DIAGNOSTICS_WAIT_MS = 300;
/**
 * Run directory-level diagnostics using the best available strategy
 * @param directory - Project directory to check
 * @param strategy - Strategy to use ('tsc', 'lsp', or 'auto')
 * @returns Diagnostic results
 */
export async function runDirectoryDiagnostics(directory, strategy = 'auto') {
    const tsconfigPath = join(directory, 'tsconfig.json');
    const hasTsconfig = existsSync(tsconfigPath);
    // Determine which strategy to use
    let useStrategy;
    if (strategy === 'auto') {
        useStrategy = hasTsconfig ? 'tsc' : 'lsp';
    }
    else {
        useStrategy = strategy;
    }
    // Run diagnostics based on strategy
    if (useStrategy === 'tsc' && hasTsconfig) {
        return formatTscResult(runTscDiagnostics(directory));
    }
    else {
        return formatLspResult(await runLspAggregatedDiagnostics(directory));
    }
}
/**
 * Format tsc results into standard format
 */
function formatTscResult(result) {
    let diagnostics = '';
    let summary = '';
    if (result.diagnostics.length === 0) {
        diagnostics = 'No diagnostics found. All files are clean!';
        summary = 'TypeScript check passed: 0 errors, 0 warnings';
    }
    else {
        // Group diagnostics by file
        const byFile = new Map();
        for (const diag of result.diagnostics) {
            if (!byFile.has(diag.file)) {
                byFile.set(diag.file, []);
            }
            byFile.get(diag.file).push(diag);
        }
        // Format each file's diagnostics
        const fileOutputs = [];
        for (const [file, diags] of byFile) {
            let fileOutput = `${file}:\n`;
            for (const diag of diags) {
                fileOutput += `  ${diag.line}:${diag.column} - ${diag.severity} ${diag.code}: ${diag.message}\n`;
            }
            fileOutputs.push(fileOutput);
        }
        diagnostics = fileOutputs.join('\n');
        summary = `TypeScript check ${result.success ? 'passed' : 'failed'}: ${result.errorCount} errors, ${result.warningCount} warnings`;
    }
    return {
        strategy: 'tsc',
        success: result.success,
        errorCount: result.errorCount,
        warningCount: result.warningCount,
        diagnostics,
        summary
    };
}
/**
 * Format LSP aggregation results into standard format
 */
function formatLspResult(result) {
    let diagnostics = '';
    let summary = '';
    if (result.diagnostics.length === 0) {
        diagnostics = `Checked ${result.filesChecked} files. No diagnostics found!`;
        summary = `LSP check passed: 0 errors, 0 warnings (${result.filesChecked} files)`;
    }
    else {
        // Group diagnostics by file
        const byFile = new Map();
        for (const item of result.diagnostics) {
            if (!byFile.has(item.file)) {
                byFile.set(item.file, []);
            }
            byFile.get(item.file).push(item);
        }
        // Format each file's diagnostics
        const fileOutputs = [];
        for (const [file, items] of byFile) {
            const diags = items.map(i => i.diagnostic);
            fileOutputs.push(`${file}:\n${formatDiagnostics(diags, file)}`);
        }
        diagnostics = fileOutputs.join('\n\n');
        summary = `LSP check ${result.success ? 'passed' : 'failed'}: ${result.errorCount} errors, ${result.warningCount} warnings (${result.filesChecked} files)`;
    }
    return {
        strategy: 'lsp',
        success: result.success,
        errorCount: result.errorCount,
        warningCount: result.warningCount,
        diagnostics,
        summary
    };
}
export { runTscDiagnostics } from './tsc-runner.js';
export { runLspAggregatedDiagnostics } from './lsp-aggregator.js';
//# sourceMappingURL=index.js.map