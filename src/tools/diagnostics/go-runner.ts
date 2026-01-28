/**
 * Go Diagnostics Runner
 *
 * Uses `go vet` for static analysis of Go projects.
 */

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { EXTERNAL_PROCESS_TIMEOUT_MS } from './index.js';

export interface GoDiagnostic {
  file: string;
  line: number;
  column: number;
  message: string;
  severity: 'error' | 'warning';
}

export interface GoResult {
  success: boolean;
  diagnostics: GoDiagnostic[];
  errorCount: number;
  warningCount: number;
  skipped?: string;
}

/**
 * Run Go vet diagnostics on a directory
 * @param directory - Project directory containing go.mod
 * @returns Result with diagnostics
 */
export function runGoDiagnostics(directory: string): GoResult {
  const goModPath = join(directory, 'go.mod');

  if (!existsSync(goModPath)) {
    return {
      success: true,
      diagnostics: [],
      errorCount: 0,
      warningCount: 0
    };
  }

  try {
    execFileSync('go', ['vet', './...'], {
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
        skipped: '`go` binary not found in PATH'
      };
    }
    const output = error.stderr || error.stdout || '';
    return parseGoOutput(output);
  }
}

/**
 * Parse go vet output
 * Format: file.go:line:col: message
 */
export function parseGoOutput(output: string): GoResult {
  const diagnostics: GoDiagnostic[] = [];
  const regex = /^(.+?\.go):(\d+):(\d+):\s+(.+)$/gm;
  let match;

  while ((match = regex.exec(output)) !== null) {
    diagnostics.push({
      file: match[1],
      line: parseInt(match[2], 10),
      column: parseInt(match[3], 10),
      message: match[4],
      severity: 'warning'
    });
  }

  return {
    success: diagnostics.length === 0,
    diagnostics,
    errorCount: 0,
    warningCount: diagnostics.length
  };
}
