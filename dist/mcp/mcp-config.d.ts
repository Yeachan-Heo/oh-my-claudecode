/**
 * MCP Configuration Module
 *
 * Environment variable configuration for MCP (Model Context Protocol) modules:
 * - OMC_MCP_OUTPUT_PATH_POLICY=strict|redirect_output (default: strict)
 * - OMC_MCP_OUTPUT_REDIRECT_DIR=.omc/outputs (default: .omc/outputs)
 * - OMC_MCP_ALLOW_EXTERNAL_PROMPT=0|1 (default: 0)
 *
 * This module provides policy resolution and path redirection logic
 * accessible from both codex-core.ts and gemini-core.ts.
 */
/**
 * Output path policy types
 */
export type OutputPathPolicy = 'strict' | 'redirect_output';
/**
 * MCP Configuration interface
 */
export interface McpConfig {
    /** Output path policy: strict (enforce boundaries) or redirect_output (redirect to safe dir) */
    outputPathPolicy: OutputPathPolicy;
    /** Directory to redirect outputs when policy is 'redirect_output' */
    outputRedirectDir: string;
    /** Whether to allow external prompt file access (outside working directory) */
    allowExternalPrompt: boolean;
}
/**
 * Default MCP configuration values
 */
export declare const DEFAULT_MCP_CONFIG: McpConfig;
/**
 * Load MCP configuration from environment variables
 */
export declare function loadMcpConfig(): McpConfig;
/**
 * Get MCP configuration (cached)
 */
export declare function getMcpConfig(): McpConfig;
/**
 * Clear the cached configuration (useful for testing)
 */
export declare function clearMcpConfigCache(): void;
/**
 * Check if external prompt access is allowed
 */
export declare function isExternalPromptAllowed(): boolean;
/**
 * Get the current output path policy
 */
export declare function getOutputPathPolicy(): OutputPathPolicy;
/**
 * Get the configured output redirect directory
 */
export declare function getOutputRedirectDir(): string;
//# sourceMappingURL=mcp-config.d.ts.map