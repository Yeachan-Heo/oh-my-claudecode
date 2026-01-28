/**
 * Directory Diagnostics - Project-level QA enforcement
 *
 * Provides strategy-based diagnostics for multiple languages:
 * - TypeScript: tsc --noEmit
 * - Go: go vet
 * - Rust: cargo check
 * - Python: mypy / pylint
 * - Fallback: LSP iteration
 */

import { existsSync, statSync, realpathSync } from 'fs';
import { join } from 'path';
import { runTscDiagnostics, TscDiagnostic, TscResult } from './tsc-runner.js';
import { runLspAggregatedDiagnostics, LspDiagnosticWithFile, LspAggregationResult } from './lsp-aggregator.js';
import { runGoDiagnostics, GoDiagnostic, GoResult } from './go-runner.js';
import { runRustDiagnostics, RustDiagnostic, RustResult } from './rust-runner.js';
import { runPythonDiagnostics, PythonDiagnostic, PythonResult } from './python-runner.js';
import { formatDiagnostics } from '../lsp/utils.js';

export const LSP_DIAGNOSTICS_WAIT_MS = 300;
export const EXTERNAL_PROCESS_TIMEOUT_MS = 300000; // 5 minutes

export type DiagnosticsStrategy = 'tsc' | 'go' | 'rust' | 'python' | 'lsp' | 'auto';

export interface DirectoryDiagnosticResult {
  strategy: 'tsc' | 'go' | 'rust' | 'python' | 'lsp' | 'skipped';
  success: boolean;
  errorCount: number;
  warningCount: number;
  diagnostics: string;
  summary: string;
}

/**
 * Base diagnostic fields that all diagnostic types share
 */
interface BaseDiagnostic {
  file: string;
  line: number;
  column: number;
  message: string;
  severity: 'error' | 'warning';
}

/**
 * Base result fields that all result types share
 */
interface BaseResult<D extends BaseDiagnostic> {
  success: boolean;
  diagnostics: D[];
  errorCount: number;
  warningCount: number;
}

/**
 * Format any diagnostic result into standard DirectoryDiagnosticResult
 * Uses generics to accept any diagnostic type that extends BaseDiagnostic.
 * The `code` property is accessed via runtime check since not all diagnostics have it.
 *
 * @param result - Result with diagnostics (TscResult, GoResult, RustResult, PythonResult)
 * @param strategy - The strategy name
 * @param toolName - Human-readable tool name for messages
 */
function formatDiagnosticResult<D extends BaseDiagnostic>(
  result: BaseResult<D>,
  strategy: 'tsc' | 'go' | 'rust' | 'python',
  toolName: string
): DirectoryDiagnosticResult {
  let diagnostics = '';
  let summary = '';

  if (result.diagnostics.length === 0) {
    diagnostics = `No diagnostics found. ${toolName} passed!`;
    summary = `${toolName} passed: 0 errors, 0 warnings`;
  } else {
    const byFile = new Map<string, D[]>();
    for (const diag of result.diagnostics) {
      if (!byFile.has(diag.file)) byFile.set(diag.file, []);
      byFile.get(diag.file)!.push(diag);
    }

    const fileOutputs: string[] = [];
    for (const [file, diags] of byFile) {
      let fileOutput = `${file}:\n`;
      for (const diag of diags) {
        // Use runtime check for 'code' since GoDiagnostic doesn't have it
        const code = 'code' in diag && diag.code ? ` [${diag.code}]` : '';
        fileOutput += `  ${diag.line}:${diag.column} - ${diag.severity}${code}: ${diag.message}\n`;
      }
      fileOutputs.push(fileOutput);
    }

    diagnostics = fileOutputs.join('\n');
    summary = `${toolName} ${result.success ? 'passed' : 'failed'}: ${result.errorCount} errors, ${result.warningCount} warnings`;
  }

  return {
    strategy,
    success: result.success,
    errorCount: result.errorCount,
    warningCount: result.warningCount,
    diagnostics,
    summary
  };
}

/**
 * Detect project type from directory contents
 *
 * Priority order (first match wins):
 * 1. tsconfig.json → 'typescript'
 * 2. go.mod → 'go'
 * 3. Cargo.toml → 'rust'
 * 4. pyproject.toml / requirements.txt / setup.py → 'python'
 * 5. (none) → 'unknown'
 *
 * Note: In monorepo scenarios with multiple project types,
 * only the first match is returned. Use explicit strategy
 * parameter to target a specific language.
 */
function detectProjectType(directory: string): 'typescript' | 'go' | 'rust' | 'python' | 'unknown' {
  if (existsSync(join(directory, 'tsconfig.json'))) return 'typescript';
  if (existsSync(join(directory, 'go.mod'))) return 'go';
  if (existsSync(join(directory, 'Cargo.toml'))) return 'rust';
  if (existsSync(join(directory, 'pyproject.toml')) ||
      existsSync(join(directory, 'requirements.txt')) ||
      existsSync(join(directory, 'setup.py'))) return 'python';
  return 'unknown';
}

/**
 * Run directory-level diagnostics using the best available strategy
 * @param directory - Project directory to check
 * @param strategy - Strategy to use ('tsc', 'go', 'rust', 'python', 'lsp', or 'auto')
 * @returns Diagnostic results
 */
export async function runDirectoryDiagnostics(
  directory: string,
  strategy: DiagnosticsStrategy = 'auto'
): Promise<DirectoryDiagnosticResult> {
  // Validate directory exists
  if (!existsSync(directory)) {
    return {
      strategy: 'skipped',
      success: true,
      errorCount: 0,
      warningCount: 0,
      diagnostics: '',
      summary: `Diagnostics skipped: directory does not exist: ${directory}`
    };
  }

  // Check if it's actually a directory (not a file)
  if (!statSync(directory).isDirectory()) {
    return {
      strategy: 'skipped',
      success: true,
      errorCount: 0,
      warningCount: 0,
      diagnostics: '',
      summary: `Diagnostics skipped: path is not a directory: ${directory}`
    };
  }

  // Resolve symlinks to normalize the path
  let resolvedDirectory: string;
  try {
    resolvedDirectory = realpathSync(directory);
  } catch {
    return {
      strategy: 'skipped',
      success: true,
      errorCount: 0,
      warningCount: 0,
      diagnostics: '',
      summary: `Diagnostics skipped: cannot resolve directory path: ${directory}`
    };
  }

  let useStrategy: 'tsc' | 'go' | 'rust' | 'python' | 'lsp';

  if (strategy === 'auto') {
    const projectType = detectProjectType(resolvedDirectory);
    switch (projectType) {
      case 'typescript': useStrategy = 'tsc'; break;
      case 'go': useStrategy = 'go'; break;
      case 'rust': useStrategy = 'rust'; break;
      case 'python': useStrategy = 'python'; break;
      default: useStrategy = 'lsp';
    }
  } else {
    // Explicit strategy requested - use it directly.
    // NOTE: Unlike the old behavior, explicit 'tsc' without tsconfig.json
    // will NOT fall back to 'lsp'. The runner handles missing config gracefully.
    useStrategy = strategy;
  }

  switch (useStrategy) {
    case 'tsc':
      return formatTscResult(runTscDiagnostics(resolvedDirectory));
    case 'go':
      return formatGoResult(runGoDiagnostics(resolvedDirectory));
    case 'rust':
      return formatRustResult(runRustDiagnostics(resolvedDirectory));
    case 'python':
      return formatPythonResult(runPythonDiagnostics(resolvedDirectory));
    case 'lsp':
    default:
      return formatLspResult(await runLspAggregatedDiagnostics(resolvedDirectory));
  }
}

/**
 * Format tsc results into standard format
 */
function formatTscResult(result: TscResult): DirectoryDiagnosticResult {
  return formatDiagnosticResult(result, 'tsc', 'TypeScript check');
}

/**
 * Format LSP aggregation results into standard format
 */
function formatLspResult(result: LspAggregationResult): DirectoryDiagnosticResult {
  let diagnostics = '';
  let summary = '';

  if (result.diagnostics.length === 0) {
    diagnostics = `Checked ${result.filesChecked} files. No diagnostics found!`;
    summary = `LSP check passed: 0 errors, 0 warnings (${result.filesChecked} files)`;
  } else {
    // Group diagnostics by file
    const byFile = new Map<string, LspDiagnosticWithFile[]>();
    for (const item of result.diagnostics) {
      if (!byFile.has(item.file)) {
        byFile.set(item.file, []);
      }
      byFile.get(item.file)!.push(item);
    }

    // Format each file's diagnostics
    const fileOutputs: string[] = [];
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

/**
 * Format Go vet results into standard format
 */
function formatGoResult(result: GoResult): DirectoryDiagnosticResult {
  if (result.skipped) {
    return {
      strategy: 'skipped',
      success: true,
      errorCount: 0,
      warningCount: 0,
      diagnostics: '',
      summary: `Go diagnostics skipped: ${result.skipped}`
    };
  }
  return formatDiagnosticResult(result, 'go', 'Go vet');
}

/**
 * Format Cargo check results into standard format
 */
function formatRustResult(result: RustResult): DirectoryDiagnosticResult {
  if (result.skipped) {
    return {
      strategy: 'skipped',
      success: true,
      errorCount: 0,
      warningCount: 0,
      diagnostics: '',
      summary: `Rust diagnostics skipped: ${result.skipped}`
    };
  }
  return formatDiagnosticResult(result, 'rust', 'Cargo check');
}

/**
 * Format Python diagnostics results into standard format
 */
function formatPythonResult(result: PythonResult): DirectoryDiagnosticResult {
  if (result.skipped) {
    return {
      strategy: 'skipped',
      success: true,
      errorCount: 0,
      warningCount: 0,
      diagnostics: '',
      summary: `Python diagnostics skipped: ${result.skipped}`
    };
  }
  const toolName = result.tool === 'mypy' ? 'Mypy' : result.tool === 'pylint' ? 'Pylint' : 'Python';
  return formatDiagnosticResult(result, 'python', toolName);
}

// Re-export types for convenience
export type { TscDiagnostic, TscResult } from './tsc-runner.js';
export type { LspDiagnosticWithFile, LspAggregationResult } from './lsp-aggregator.js';
export type { GoDiagnostic, GoResult } from './go-runner.js';
export type { RustDiagnostic, RustResult } from './rust-runner.js';
export type { PythonDiagnostic, PythonResult } from './python-runner.js';
export { runTscDiagnostics } from './tsc-runner.js';
export { runLspAggregatedDiagnostics } from './lsp-aggregator.js';
export { runGoDiagnostics } from './go-runner.js';
export { runRustDiagnostics } from './rust-runner.js';
export { runPythonDiagnostics } from './python-runner.js';
export { detectProjectType };
