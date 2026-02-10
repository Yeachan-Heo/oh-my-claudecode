/**
 * TypeScript Compiler Diagnostics Runner
 *
 * Executes `tsc --noEmit` to get project-level type checking diagnostics.
 */
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
export declare function runTscDiagnostics(directory: string): TscResult;
//# sourceMappingURL=tsc-runner.d.ts.map