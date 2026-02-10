/**
 * LSP Aggregator - Fallback strategy for directory diagnostics
 *
 * When tsc is not available or not suitable, iterate through files
 * and collect LSP diagnostics for each.
 */
import type { Diagnostic } from '../lsp/index.js';
export interface LspDiagnosticWithFile {
    file: string;
    diagnostic: Diagnostic;
}
export interface LspAggregationResult {
    success: boolean;
    diagnostics: LspDiagnosticWithFile[];
    errorCount: number;
    warningCount: number;
    filesChecked: number;
}
/**
 * Run LSP diagnostics on all TypeScript/JavaScript files in a directory
 * @param directory - Project directory to scan
 * @param extensions - File extensions to check (default: ['.ts', '.tsx', '.js', '.jsx'])
 * @returns Aggregated diagnostics from all files
 */
export declare function runLspAggregatedDiagnostics(directory: string, extensions?: string[]): Promise<LspAggregationResult>;
//# sourceMappingURL=lsp-aggregator.d.ts.map