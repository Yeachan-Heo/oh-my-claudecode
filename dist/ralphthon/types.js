/**
 * Ralphthon Types
 *
 * Autonomous hackathon lifecycle mode.
 * Deep-interview generates PRD, ralph loop executes tasks,
 * auto-hardening phase generates edge case/test/quality tasks,
 * terminates after N consecutive hardening waves with no new issues.
 */
// ============================================================================
// Defaults
// ============================================================================
export const RALPHTHON_DEFAULTS = {
    maxWaves: 10,
    cleanWavesForTermination: 3,
    pollIntervalMs: 120_000, // 2 minutes
    idleThresholdMs: 30_000, // 30 seconds
    maxRetries: 3,
    skipInterview: false,
};
export const PRD_FILENAME = "ralphthon-prd.json";
//# sourceMappingURL=types.js.map