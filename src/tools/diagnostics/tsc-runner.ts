/**
 * TypeScript Compiler Diagnostics Runner
 *
 * Executes `tsc --noEmit` to get project-level type checking diagnostics.
 */

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

export interface TscDiagnostic {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface TscResult {
  success: boolean;
  diagnostics: TscDiagnostic[];
  errorCount: number;
  warningCount: number;
}

/**
 * Run TypeScript compiler diagnostics on a directory
 * @param directory - Project directory containing tsconfig.json
 * @returns Result with diagnostics, error count, and warning count
 */
export function runTscDiagnostics(directory: string): TscResult {
  const tsconfigPath = join(directory, 'tsconfig.json');

  if (!existsSync(tsconfigPath)) {
    return {
      success: true,
      diagnostics: [],
      errorCount: 0,
      warningCount: 0
    };
  }

  try {
    execFileSync('tsc', ['--noEmit', '--pretty', 'false'], { windowsHide: true,
      cwd: directory,
      encoding: 'utf-8',
      stdio: 'pipe'
    });
    return {
      success: true,
      diagnostics: [],
      errorCount: 0,
      warningCount: 0
    };
  } catch (error: any) {
    const output = error.stdout || error.stderr || '';
    return parseTscOutput(output);
  }
}

/**
 * Parse TypeScript compiler output into structured diagnostics
 * Format: file(line,col): error TS1234: message
 */
function parseTscOutput(output: string): TscResult {
  const diagnostics: TscDiagnostic[] = [];

  // Parse tsc output format: file(line,col): error TS1234: message
  const regex = /^(.+)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/gm;
  let match;

  while ((match = regex.exec(output)) !== null) {
    diagnostics.push({
      file: match[1],
      line: parseInt(match[2], 10),
      column: parseInt(match[3], 10),
      severity: match[4] as 'error' | 'warning',
      code: match[5],
      message: match[6]
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
