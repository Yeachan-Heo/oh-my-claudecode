/**
 * CLI Detection Utility
 *
 * Detects whether Codex and Gemini CLIs are installed and available on the system PATH.
 * Results are cached per-session to avoid repeated filesystem checks.
 */
export interface CliDetectionResult {
    available: boolean;
    path?: string;
    version?: string;
    error?: string;
    installHint: string;
}
/**
 * Detect if Codex CLI is installed and available
 */
export declare function detectCodexCli(useCache?: boolean): CliDetectionResult;
/**
 * Detect if Gemini CLI is installed and available
 */
export declare function detectGeminiCli(useCache?: boolean): CliDetectionResult;
/**
 * Reset detection cache (useful for testing)
 */
export declare function resetDetectionCache(): void;
//# sourceMappingURL=cli-detection.d.ts.map