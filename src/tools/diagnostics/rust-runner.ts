/**
 * Rust Diagnostics Runner
 *
 * Uses `cargo check` for fast type checking of Rust projects.
 */

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { EXTERNAL_PROCESS_TIMEOUT_MS } from './index.js';

export interface RustDiagnostic {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface RustResult {
  success: boolean;
  diagnostics: RustDiagnostic[];
  errorCount: number;
  warningCount: number;
  skipped?: string;
}

/**
 * Run Cargo check diagnostics on a directory
 * @param directory - Project directory containing Cargo.toml
 * @returns Result with diagnostics
 */
export function runRustDiagnostics(directory: string): RustResult {
  const cargoPath = join(directory, 'Cargo.toml');

  if (!existsSync(cargoPath)) {
    return {
      success: true,
      diagnostics: [],
      errorCount: 0,
      warningCount: 0
    };
  }

  try {
    execFileSync('cargo', ['check'], {
      cwd: directory,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: EXTERNAL_PROCESS_TIMEOUT_MS
    });
    return {
      success: true,
      diagnostics: [],
      errorCount: 0,
      warningCount: 0
    };
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return {
        success: true,
        diagnostics: [],
        errorCount: 0,
        warningCount: 0,
        skipped: '`cargo` binary not found in PATH'
      };
    }
    const output = error.stderr || error.stdout || '';
    return parseRustOutput(output);
  }
}

/**
 * Parse cargo check output
 * Format: error[E0123]: message
 *   --> file.rs:line:col
 */
export function parseRustOutput(output: string): RustResult {
  const diagnostics: RustDiagnostic[] = [];

  const regex = /(error|warning)(?:\[([A-Z]\d+)\])?: ([^\n]+)\n(?:[^\n]*\n)*?\s+-->\s+([^\n:]+):(\d+):(\d+)/g;
  let match;

  while ((match = regex.exec(output)) !== null) {
    diagnostics.push({
      severity: match[1] as 'error' | 'warning',
      code: match[2] || '',
      message: match[3],
      file: match[4],
      line: parseInt(match[5], 10),
      column: parseInt(match[6], 10)
    });
  }

  const errorCount = diagnostics.filter(d => d.severity === 'error').length;
  const warningCount = diagnostics.filter(d => d.severity === 'warning').length;

  return {
    success: errorCount === 0,
    diagnostics,
    errorCount,
    warningCount
  };
}
