/**
 * Directory Diagnostics - Project-level QA enforcement
 *
 * Provides dual strategy for checking TypeScript/JavaScript projects:
 * 1. Primary: tsc --noEmit (fast, comprehensive)
 * 2. Fallback: LSP iteration (when tsc not available)
 */
import { LspAggregationResult } from './lsp-aggregator.js';
export declare const LSP_DIAGNOSTICS_WAIT_MS = 300;
export type DiagnosticsStrategy = 'tsc' | 'lsp' | 'auto';
export interface DirectoryDiagnosticResult {
    strategy: 'tsc' | 'lsp';
    success: boolean;
    errorCount: number;
    warningCount: number;
    diagnostics: string;
    summary: string;
}
/**
 * Run directory-level diagnostics using the best available strategy
 * @param directory - Project directory to check
 * @param strategy - Strategy to use ('tsc', 'lsp', or 'auto')
 * @returns Diagnostic results
 */
export declare function runDirectoryDiagnostics(directory: string, strategy?: DiagnosticsStrategy): Promise<DirectoryDiagnosticResult>;
/**
 * Format LSP aggregation results into standard format
 */
export declare function formatLspResult(result: LspAggregationResult): DirectoryDiagnosticResult;
export type { TscDiagnostic, TscResult } from './tsc-runner.js';
export type { LspDiagnosticWithFile, LspAggregationResult } from './lsp-aggregator.js';
export { runTscDiagnostics } from './tsc-runner.js';
export { runLspAggregatedDiagnostics } from './lsp-aggregator.js';
//# sourceMappingURL=index.d.ts.map