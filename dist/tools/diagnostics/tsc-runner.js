/**
 * TypeScript Compiler Diagnostics Runner
 *
 * Executes `tsc --noEmit` to get project-level type checking diagnostics.
 */
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { findTypeScriptPackageRoot } from '../lsp/servers.js';
const TSC_ARGS = ['--noEmit', '--pretty', 'false'];
/**
 * Run TypeScript compiler diagnostics on a directory
 * @param directory - Project directory containing tsconfig.json
 * @returns Result with diagnostics, error count, and warning count
 */
export function runTscDiagnostics(directory) {
    const tsconfigPath = join(directory, 'tsconfig.json');
    if (!existsSync(tsconfigPath)) {
        return {
            success: true,
            diagnostics: [],
            errorCount: 0,
            warningCount: 0
        };
    }
    // Prefer the project's own TypeScript, run with node: no PATH lookup, no shell.
    // Otherwise use a PATH `tsc`; on win32 that is the tsc.cmd shim, which Node can
    // only start through cmd.exe, so it gets a fixed command line.
    const typescriptRoot = findTypeScriptPackageRoot(directory);
    const localTscPath = typescriptRoot ? join(typescriptRoot, 'bin', 'tsc') : null;
    const localTsc = localTscPath && existsSync(localTscPath) ? localTscPath : null;
    const viaCmd = !localTsc && process.platform === 'win32';
    // cmd.exe exits 1 for an unknown command as for a failing one; ask where.exe instead.
    if (viaCmd && !isOnWindowsPath('tsc')) {
        return tscNotFound(directory, "where.exe found no 'tsc'");
    }
    const [file, args] = localTsc
        ? [process.execPath, [localTsc, ...TSC_ARGS]]
        : viaCmd
            ? [process.env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', ['tsc', ...TSC_ARGS].join(' ')]]
            : ['tsc', TSC_ARGS];
    try {
        execFileSync(file, args, {
            cwd: directory,
            encoding: 'utf-8',
            stdio: 'pipe',
            ...(viaCmd ? { windowsVerbatimArguments: true } : {}),
        });
        return {
            success: true,
            diagnostics: [],
            errorCount: 0,
            warningCount: 0
        };
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            return tscNotFound(directory, error.message);
        }
        const output = error.stdout || error.stderr || '';
        const result = parseTscOutput(output);
        return {
            ...result,
            success: false,
            errorCount: Math.max(1, result.errorCount),
            ...(result.diagnostics.length === 0 ? { error: output.trim() || error.message } : {}),
        };
    }
}
function isOnWindowsPath(command) {
    try {
        execFileSync('where.exe', [command], { stdio: 'ignore', windowsHide: true });
        return true;
    }
    catch {
        return false;
    }
}
function tscNotFound(directory, detail) {
    return {
        success: false,
        diagnostics: [],
        errorCount: 1,
        warningCount: 0,
        error: `tsc not found: no typescript package in ${directory} or its parent directories and no tsc on PATH (${detail}). `
            + 'Install typescript in the project to enable TypeScript directory diagnostics.',
    };
}
/**
 * Parse TypeScript compiler output into structured diagnostics
 * Format: file(line,col): error TS1234: message
 */
function parseTscOutput(output) {
    const diagnostics = [];
    // Parse tsc output format: file(line,col): error TS1234: message
    const regex = /^(.+)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/gm;
    let match;
    while ((match = regex.exec(output)) !== null) {
        diagnostics.push({
            file: match[1],
            line: parseInt(match[2], 10),
            column: parseInt(match[3], 10),
            severity: match[4],
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
//# sourceMappingURL=tsc-runner.js.map