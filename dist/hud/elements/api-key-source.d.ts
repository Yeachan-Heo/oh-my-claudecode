/**
 * OMC HUD - API Key Source Element
 *
 * Detects and renders where the active ANTHROPIC_API_KEY comes from:
 * - 'project': set in .claude/settings.local.json (project-level)
 * - 'global': set in ~/.claude/settings.json (user-level)
 * - 'env': present only as an environment variable
 *
 * Never displays the actual key value.
 */
export type ApiKeySource = 'project' | 'global' | 'env';
/**
 * Detect where the active ANTHROPIC_API_KEY comes from.
 *
 * Priority:
 * 1. Project-level: .claude/settings.local.json in cwd
 * 2. Global-level: ~/.claude/settings.json
 * 3. Environment variable
 *
 * @param cwd - Current working directory (project root)
 * @returns The source identifier, or null if no key is found
 */
export declare function detectApiKeySource(cwd?: string): ApiKeySource | null;
/**
 * Render API key source element.
 *
 * Format: key:project / key:global / key:env
 */
export declare function renderApiKeySource(source: ApiKeySource | null): string | null;
//# sourceMappingURL=api-key-source.d.ts.map