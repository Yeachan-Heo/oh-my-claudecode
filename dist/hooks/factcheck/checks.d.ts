/**
 * Factcheck Guard - Individual Check Functions
 *
 * Each function validates a specific aspect of the claims payload and
 * returns a list of mismatches. Ported from factcheck.py.
 */
import type { FactcheckPolicy, Mismatch, FactcheckMode } from './types.js';
/**
 * Check for missing required top-level fields.
 */
export declare function checkMissingFields(claims: Record<string, unknown>): string[];
/**
 * Check for missing required gates.
 */
export declare function checkMissingGates(claims: Record<string, unknown>): string[];
/**
 * Get required gates that are false.
 */
export declare function getFalseGates(claims: Record<string, unknown>): string[];
/**
 * Count source files (modified + created).
 */
export declare function sourceFileCount(claims: Record<string, unknown>): number;
/**
 * Check file paths for forbidden prefixes/substrings and existence.
 */
export declare function checkPaths(claims: Record<string, unknown>, policy: FactcheckPolicy): Mismatch[];
/**
 * Check executed commands for forbidden mutating operations.
 */
export declare function checkCommands(claims: Record<string, unknown>, policy: FactcheckPolicy): Mismatch[];
/**
 * Check that claims.cwd matches the runtime working directory.
 */
export declare function checkCwdParity(claimsCwd: string, runtimeCwd: string, mode: FactcheckMode, policy: FactcheckPolicy): Mismatch | null;
//# sourceMappingURL=checks.d.ts.map