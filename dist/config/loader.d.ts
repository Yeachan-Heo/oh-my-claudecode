/**
 * Configuration Loader
 *
 * Handles loading and merging configuration from multiple sources:
 * - User config: ~/.config/claude-omc/config.jsonc
 * - Project config: .claude/omc.jsonc
 * - Environment variables
 */
import type { PluginConfig } from '../shared/types.js';
/**
 * Default configuration.
 *
 * Model IDs are resolved from environment variables (OMC_MODEL_HIGH,
 * OMC_MODEL_MEDIUM, OMC_MODEL_LOW) with built-in fallbacks.
 * User/project config files can further override via deepMerge.
 */
export declare const DEFAULT_CONFIG: PluginConfig;
/**
 * Configuration file locations
 */
export declare function getConfigPaths(): {
    user: string;
    project: string;
};
/**
 * Load and parse a JSONC file
 */
export declare function loadJsoncFile(path: string): PluginConfig | null;
/**
 * Deep merge two objects
 */
export declare function deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T;
/**
 * Load configuration from environment variables
 */
export declare function loadEnvConfig(): Partial<PluginConfig>;
/**
 * Load and merge all configuration sources
 */
export declare function loadConfig(): PluginConfig;
/**
 * Find and load AGENTS.md or CLAUDE.md files for context injection
 */
export declare function findContextFiles(startDir?: string): string[];
/**
 * Load context from AGENTS.md/CLAUDE.md files
 */
export declare function loadContextFromFiles(files: string[]): string;
/**
 * Generate JSON Schema for configuration (for editor autocomplete)
 */
export declare function generateConfigSchema(): object;
//# sourceMappingURL=loader.d.ts.map