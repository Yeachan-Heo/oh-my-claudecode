/**
 * Python Diagnostics Runner
 *
 * Uses mypy for type checking of Python projects.
 * Falls back to pylint if mypy unavailable.
 */

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { commandExists } from '../lsp/servers.js';
import { EXTERNAL_PROCESS_TIMEOUT_MS } from './index.js';

export interface PythonDiagnostic {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface PythonResult {
  success: boolean;
  diagnostics: PythonDiagnostic[];
  errorCount: number;
  warningCount: number;
  tool: 'mypy' | 'pylint' | 'none';
  skipped?: string;
}


/**
 * Run Python diagnostics on a directory
 * @param directory - Project directory
 * @returns Result with diagnostics
 */
export function runPythonDiagnostics(directory: string): PythonResult {
  const hasPyproject = existsSync(join(directory, 'pyproject.toml'));
  const hasRequirements = existsSync(join(directory, 'requirements.txt'));
  const hasSetupPy = existsSync(join(directory, 'setup.py'));

  if (!hasPyproject && !hasRequirements && !hasSetupPy) {
    return {
      success: true,
      diagnostics: [],
      errorCount: 0,
      warningCount: 0,
      tool: 'none'
    };
  }

  if (commandExists('mypy')) {
    return runMypy(directory);
  }

  if (commandExists('pylint')) {
    return runPylint(directory);
  }

  return {
    success: true,
    diagnostics: [],
    errorCount: 0,
    warningCount: 0,
    tool: 'none'
  };
}

function runMypy(directory: string): PythonResult {
  try {
    execFileSync('mypy', ['.', '--ignore-missing-imports'], {
      cwd: directory,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: EXTERNAL_PROCESS_TIMEOUT_MS
    });
    return {
      success: true,
      diagnostics: [],
      errorCount: 0,
      warningCount: 0,
      tool: 'mypy'
    };
  } catch (error: any) {
    const output = error.stdout || '';
    if (error.code === 'ENOENT') {
      return {
        success: true,
        diagnostics: [],
        errorCount: 0,
        warningCount: 0,
        tool: 'mypy',
        skipped: '`mypy` binary not found in PATH'
      };
    }
    if (!output.trim()) {
      return {
        success: false,
        diagnostics: [{
          file: '.',
          line: 0,
          column: 0,
          code: 'mypy-crash',
          message: 'mypy exited with errors but produced no diagnostic output (possible configuration issue)',
          severity: 'error'
        }],
        errorCount: 1,
        warningCount: 0,
        tool: 'mypy'
      };
    }
    return parseMypyOutput(output);
  }
}

/**
 * Parse mypy output
 * Format: file.py:line:col: severity: message [code]
 */
export function parseMypyOutput(output: string): PythonResult {
  const diagnostics: PythonDiagnostic[] = [];
  const regex = /^(.+?\.py):(\d+):(\d+): (error|warning|note): (.+?)(?:\s+\[([^\]]+)\])?$/gm;
  let match;

  while ((match = regex.exec(output)) !== null) {
    if (match[4] === 'note') continue;
    diagnostics.push({
      file: match[1],
      line: parseInt(match[2], 10),
      column: parseInt(match[3], 10),
      severity: match[4] === 'error' ? 'error' : 'warning',
      message: match[5],
      code: match[6] || ''
    });
  }

  const errorCount = diagnostics.filter(d => d.severity === 'error').length;
  const warningCount = diagnostics.filter(d => d.severity === 'warning').length;

  return {
    success: errorCount === 0,
    diagnostics,
    errorCount,
    warningCount,
    tool: 'mypy'
  };
}

function runPylint(directory: string): PythonResult {
  try {
    execFileSync('pylint', ['--output-format=text', '--score=no', '.'], {
      cwd: directory,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: EXTERNAL_PROCESS_TIMEOUT_MS
    });
    return {
      success: true,
      diagnostics: [],
      errorCount: 0,
      warningCount: 0,
      tool: 'pylint'
    };
  } catch (error: any) {
    const output = error.stdout || error.stderr || '';
    if (error.code === 'ENOENT') {
      return {
        success: true,
        diagnostics: [],
        errorCount: 0,
        warningCount: 0,
        tool: 'pylint',
        skipped: '`pylint` binary not found in PATH'
      };
    }
    if (!output.trim()) {
      return {
        success: false,
        diagnostics: [{
          file: '.',
          line: 0,
          column: 0,
          code: 'pylint-crash',
          message: 'pylint exited with errors but produced no diagnostic output (possible configuration issue)',
          severity: 'error'
        }],
        errorCount: 1,
        warningCount: 0,
        tool: 'pylint'
      };
    }
    return parsePylintOutput(output);
  }
}

/**
 * Parse pylint output
 * Format: file.py:line:col: code: message
 */
export function parsePylintOutput(output: string): PythonResult {
  const diagnostics: PythonDiagnostic[] = [];
  const regex = /^(.+?\.py):(\d+):(\d+): ([A-Z]\d+): (.+)$/gm;
  let match;

  while ((match = regex.exec(output)) !== null) {
    const code = match[4];
    const isError = code.startsWith('E') || code.startsWith('F');
    diagnostics.push({
      file: match[1],
      line: parseInt(match[2], 10),
      column: parseInt(match[3], 10),
      code: code,
      message: match[5],
      severity: isError ? 'error' : 'warning'
    });
  }

  const errorCount = diagnostics.filter(d => d.severity === 'error').length;
  const warningCount = diagnostics.filter(d => d.severity === 'warning').length;

  return {
    success: errorCount === 0,
    diagnostics,
    errorCount,
    warningCount,
    tool: 'pylint'
  };
}
