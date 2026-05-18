/**
 * Directory Diagnostics - Project-level QA enforcement
 *
 * Provides dual strategy for checking TypeScript/JavaScript projects:
 * 1. Primary: tsc --noEmit (fast, comprehensive)
 * 2. Fallback: LSP iteration (when tsc not available)
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { runTscDiagnostics, TscDiagnostic, TscResult } from './tsc-runner.js';
import { runLspAggregatedDiagnostics, LspDiagnosticWithFile, LspAggregationResult } from './lsp-aggregator.js';
import { formatDiagnostics } from '../lsp/utils.js';

export const LSP_DIAGNOSTICS_WAIT_MS = 300;

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
export async function runDirectoryDiagnostics(
  directory: string,
  strategy: DiagnosticsStrategy = 'auto'
): Promise<DirectoryDiagnosticResult> {
  const tsconfigPath = join(directory, 'tsconfig.json');
  const hasTsconfig = existsSync(tsconfigPath);

  // Determine which strategy to use
  let useStrategy: 'tsc' | 'lsp';
  if (strategy === 'auto') {
    useStrategy = hasTsconfig ? 'tsc' : 'lsp';
  } else {
    useStrategy = strategy;
  }

  // Run diagnostics based on strategy
  if (useStrategy === 'tsc' && hasTsconfig) {
    return formatTscResult(runTscDiagnostics(directory));
  } else {
    return formatLspResult(await runLspAggregatedDiagnostics(directory));
  }
}

/**
 * Format tsc results into standard format
 */
function formatTscResult(result: TscResult): DirectoryDiagnosticResult {
  let diagnostics = '';
  let summary = '';

  if (result.diagnostics.length === 0) {
    diagnostics = 'No diagnostics found. All files are clean!';
    summary = 'TypeScript check passed: 0 errors, 0 warnings';
  } else {
    // Group diagnostics by file
    const byFile = new Map<string, TscDiagnostic[]>();
    for (const diag of result.diagnostics) {
      if (!byFile.has(diag.file)) {
        byFile.set(diag.file, []);
      }
      byFile.get(diag.file)!.push(diag);
    }

    // Format each file's diagnostics
    const fileOutputs: string[] = [];
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
export function formatLspResult(result: LspAggregationResult): DirectoryDiagnosticResult {
  let diagnostics = '';
  let summary = '';

  if (result.diagnostics.length === 0 && result.installHints.length === 0 && result.skippedFiles.length === 0) {
    diagnostics = `Checked ${result.filesChecked} files. No diagnostics found!`;
    summary = `LSP check passed: 0 errors, 0 warnings (${result.filesChecked} files)`;
  } else {
    const hasSkips = result.skippedFiles.length > 0;
    const parts: string[] = [];

    if (result.installHints.length > 0) {
      const hintLines = result.installHints.map(h => `  - ${h}`).join('\n');
      parts.push(
        `⚠ Missing language servers detected:\n${hintLines}\nInstall the language server(s) above and re-run, or these files cannot be checked.`
      );
    }

    if (result.diagnostics.length > 0) {
      const byFile = new Map<string, LspDiagnosticWithFile[]>();
      for (const item of result.diagnostics) {
        if (!byFile.has(item.file)) {
          byFile.set(item.file, []);
        }
        byFile.get(item.file)!.push(item);
      }

      const fileOutputs: string[] = [];
      for (const [file, items] of byFile) {
        const diags = items.map(i => i.diagnostic);
        fileOutputs.push(`${file}:\n${formatDiagnostics(diags, file)}`);
      }

      parts.push(fileOutputs.join('\n\n'));
    }

    if (hasSkips) {
      parts.push(`Skipped ${result.skippedFiles.length} file(s) due to missing or unregistered language servers.`);
    }

    diagnostics = parts.join('\n\n');
    summary = hasSkips
      ? `LSP check incomplete: ${result.errorCount} errors, ${result.warningCount} warnings (${result.filesChecked}/${result.filesChecked + result.skippedFiles.length} files checked)`
      : `LSP check ${result.success ? 'passed' : 'failed'}: ${result.errorCount} errors, ${result.warningCount} warnings (${result.filesChecked} files)`;
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

// Re-export types for convenience
export type { TscDiagnostic, TscResult } from './tsc-runner.js';
export type { LspDiagnosticWithFile, LspAggregationResult } from './lsp-aggregator.js';
export { runTscDiagnostics } from './tsc-runner.js';
export { runLspAggregatedDiagnostics } from './lsp-aggregator.js';
