/**
 * MCP Configuration Module
 *
 * Environment variable configuration for MCP (Model Context Protocol) modules:
 * - OMC_MCP_OUTPUT_PATH_POLICY=strict|redirect_output (default: strict)
 * - OMC_MCP_OUTPUT_REDIRECT_DIR=.omc/outputs (default: .omc/outputs)
 * - OMC_MCP_ALLOW_EXTERNAL_PROMPT=0|1 (default: 0)
 *
 * This module provides policy resolution and path redirection logic
 * accessible across MCP server modules.
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
export const DEFAULT_MCP_CONFIG: McpConfig = {
  outputPathPolicy: 'strict',
  outputRedirectDir: '.omc/outputs',
  allowExternalPrompt: false,
};

/**
 * Parse environment variable to OutputPathPolicy
 */
function parseOutputPathPolicy(value: string | undefined): OutputPathPolicy {
  if (value === 'redirect_output') {
    return 'redirect_output';
  }
  // Default to strict for any other value (including undefined)
  return 'strict';
}

/**
 * Parse boolean-like environment variable (0|1, true|false)
 */
function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === '') {
    return defaultValue;
  }
  return value === '1' || value.toLowerCase() === 'true';
}

/**
 * Load MCP configuration from environment variables
 */
export function loadMcpConfig(): McpConfig {
  const outputPathPolicy = parseOutputPathPolicy(process.env.OMC_MCP_OUTPUT_PATH_POLICY);
  const outputRedirectDir = process.env.OMC_MCP_OUTPUT_REDIRECT_DIR || DEFAULT_MCP_CONFIG.outputRedirectDir;
  const allowExternalPrompt = parseBooleanEnv(process.env.OMC_MCP_ALLOW_EXTERNAL_PROMPT, DEFAULT_MCP_CONFIG.allowExternalPrompt);

  const config: McpConfig = {
    outputPathPolicy,
    outputRedirectDir,
    allowExternalPrompt,
  };

  // Log warning if external prompt access is enabled (security consideration)
  if (config.allowExternalPrompt) {
    console.warn('[MCP Config] WARNING: OMC_MCP_ALLOW_EXTERNAL_PROMPT is enabled. External prompt files outside the working directory are allowed. This may pose a security risk.');
  }

  return config;
}

/**
 * Cached configuration (lazy-loaded on first access)
 */
let cachedConfig: McpConfig | null = null;

/**
 * Get MCP configuration (cached)
 */
export function getMcpConfig(): McpConfig {
  if (!cachedConfig) {
    cachedConfig = loadMcpConfig();
  }
  return cachedConfig;
}

/**
 * Clear the cached configuration (useful for testing)
 */
export function clearMcpConfigCache(): void {
  cachedConfig = null;
}

/**
 * Check if external prompt access is allowed
 */
export function isExternalPromptAllowed(): boolean {
  return getMcpConfig().allowExternalPrompt;
}

/**
 * Get the current output path policy
 */
export function getOutputPathPolicy(): OutputPathPolicy {
  return getMcpConfig().outputPathPolicy;
}

/**
 * Get the configured output redirect directory
 */
export function getOutputRedirectDir(): string {
  return getMcpConfig().outputRedirectDir;
}
