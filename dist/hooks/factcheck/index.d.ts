/**
 * Factcheck Guard - Main Entry Point
 *
 * Portable factcheck engine that validates a claims payload against
 * configurable policies. Ported from rolldav/portable-omc-guards (issue #1155).
 *
 * Modes:
 *   - strict:   All gates must be true, cwd mismatch is FAIL
 *   - declared:  Warns on false gates if source files exist
 *   - manual:   Same as declared
 *   - quick:    Skips cwd parity check by default
 */
import type { FactcheckMode, FactcheckPolicy, FactcheckResult } from './types.js';
export type { FactcheckClaims, FactcheckMode, FactcheckPolicy, FactcheckResult, Mismatch, Severity, } from './types.js';
export { loadGuardsConfig, shouldUseStrictMode } from './config.js';
/**
 * Run the portable factcheck logic against a claims payload.
 *
 * @param claims     - The claims payload to validate
 * @param mode       - Validation mode: strict | declared | manual | quick
 * @param policy     - Factcheck policy (loaded from config or provided)
 * @param runtimeCwd - Runtime working directory (defaults to process.cwd())
 * @returns Factcheck result with verdict, mismatches, notes, and evidence
 */
export declare function runChecks(claims: Record<string, unknown>, mode: FactcheckMode, policy: FactcheckPolicy, runtimeCwd?: string): FactcheckResult;
/**
 * Convenience wrapper: load config and run checks in one call.
 */
export declare function runFactcheck(claims: Record<string, unknown>, options?: {
    mode?: FactcheckMode;
    runtimeCwd?: string;
    workspace?: string;
}): FactcheckResult;
//# sourceMappingURL=index.d.ts.map