export { isCliAvailable, validateCliAvailable, getContract, type CliAgentType } from './model-contract.js';
export interface CliInfo {
    available: boolean;
    version?: string;
    path?: string;
}
/** The narrow diagnostic result used by doctor-facing callers. */
export interface CliProbeResult {
    found: boolean;
    path?: string;
    version?: string;
    error?: string;
}
/** Resolve a provider CLI and perform a bounded, shell-free optional version probe. */
export declare function probeCli(binary: string, platform?: NodeJS.Platform): CliProbeResult;
/**
 * Legacy detector projection. `available` intentionally remains tied to a
 * status-zero version process rather than to successful path resolution.
 */
export declare function detectCli(binary: string): CliInfo;
export declare function detectAllClis(): Record<string, CliInfo>;
//# sourceMappingURL=cli-detection.d.ts.map