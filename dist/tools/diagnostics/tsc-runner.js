/**
 * TypeScript Compiler Diagnostics Runner
 *
 * Executes `tsc --noEmit` to get project-level type checking diagnostics.
 */
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
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
    try {
        execSync('tsc --noEmit --pretty false', {
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
    }
    catch (error) {
        const output = error.stdout || error.stderr || '';
        return parseTscOutput(output);
    }
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