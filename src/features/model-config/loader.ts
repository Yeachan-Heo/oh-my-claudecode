/**
 * Model Config Loader
 *
 * Loads and validates `.claude/models.json` configuration.
 * Resolves environment variable references in API keys.
 * Caches loaded config per session.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { ModelsConfig, ProviderConfig, AgentModelConfig } from './types.js';
import { CLAUDE_TIERS } from './types.js';

/** Cached config instance (session-scoped) */
let cachedConfig: ModelsConfig | null = null;
let cachedConfigPath: string | null = null;

/**
 * Get the path to .claude/models.json in the project root
 */
export function getModelsConfigPath(projectRoot?: string): string {
  const root = projectRoot || process.cwd();
  return join(root, '.claude', 'models.json');
}

/**
 * Resolve an API key value.
 * If it starts with "$", treat it as an env var reference.
 * Otherwise return the raw value.
 */
export function resolveApiKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith('$')) {
    const envVar = value.slice(1);
    return process.env[envVar] || undefined;
  }
  return value;
}

/**
 * Load and parse .claude/models.json
 * Returns null if the file doesn't exist.
 * Throws on parse errors.
 */
export function loadModelsConfigFromFile(projectRoot?: string): ModelsConfig | null {
  const configPath = getModelsConfigPath(projectRoot);

  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    // Strip comments (// and /* */) for JSONC compatibility
    const stripped = content
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    return JSON.parse(stripped) as ModelsConfig;
  } catch (error) {
    throw new Error(`Failed to parse ${configPath}: ${(error as Error).message}`);
  }
}

/**
 * Validate a loaded models config.
 * Checks provider references in agent configs, model availability, etc.
 * Returns an array of warning messages (empty = valid).
 */
export function validateConfig(config: ModelsConfig): string[] {
  const warnings: string[] = [];
  const providerNames = new Set(Object.keys(config.providers || {}));
  // "claude" is always a valid provider
  providerNames.add('claude');

  // Validate agent configs
  if (config.agents) {
    for (const [agentName, agentConfig] of Object.entries(config.agents)) {
      // Check provider reference
      if (!providerNames.has(agentConfig.provider)) {
        warnings.push(`Agent "${agentName}" references unknown provider "${agentConfig.provider}"`);
      }

      // Check model for claude provider
      if (agentConfig.provider === 'claude' && !CLAUDE_TIERS.includes(agentConfig.model)) {
        warnings.push(`Agent "${agentName}" uses claude provider but model "${agentConfig.model}" is not a valid tier (${CLAUDE_TIERS.join(', ')})`);
      }

      // Check model is in provider's model list
      if (agentConfig.provider !== 'claude' && config.providers?.[agentConfig.provider]) {
        const provider = config.providers[agentConfig.provider];
        if (provider.models.length > 0 && !provider.models.includes(agentConfig.model)) {
          warnings.push(`Agent "${agentName}" uses model "${agentConfig.model}" not listed in provider "${agentConfig.provider}" models`);
        }
      }

      // Validate fallback tier
      if (agentConfig.fallback && !CLAUDE_TIERS.includes(agentConfig.fallback)) {
        warnings.push(`Agent "${agentName}" has invalid fallback tier "${agentConfig.fallback}"`);
      }
    }
  }

  // Validate defaults
  if (config.defaults) {
    if (!providerNames.has(config.defaults.provider)) {
      warnings.push(`Default config references unknown provider "${config.defaults.provider}"`);
    }
  }

  // Validate providers have baseUrl
  if (config.providers) {
    for (const [name, provider] of Object.entries(config.providers)) {
      if (!provider.baseUrl) {
        warnings.push(`Provider "${name}" is missing baseUrl`);
      }
    }
  }

  return warnings;
}

/**
 * Load models config with caching.
 * Returns the cached config if the same project root is used.
 */
export function loadModelsConfig(projectRoot?: string): ModelsConfig | null {
  const configPath = getModelsConfigPath(projectRoot);

  if (cachedConfig !== null && cachedConfigPath === configPath) {
    return cachedConfig;
  }

  const config = loadModelsConfigFromFile(projectRoot);
  if (config) {
    const warnings = validateConfig(config);
    if (warnings.length > 0) {
      console.warn('[model-config] Validation warnings:', warnings.join('; '));
    }
  }

  cachedConfig = config;
  cachedConfigPath = configPath;
  return config;
}

/**
 * Get the model config for a specific agent.
 * Returns the agent-specific config, or defaults, or null.
 */
export function getAgentModelConfig(agentName: string, projectRoot?: string): AgentModelConfig | null {
  const config = loadModelsConfig(projectRoot);
  if (!config) return null;

  // Check agent-specific config first
  if (config.agents?.[agentName]) {
    return config.agents[agentName];
  }

  // Fall back to defaults
  if (config.defaults) {
    return config.defaults;
  }

  return null;
}

/**
 * Resolve the full provider config (with API key resolved) for a provider name.
 */
export function getResolvedProviderConfig(providerName: string, projectRoot?: string): (ProviderConfig & { resolvedApiKey?: string }) | null {
  const config = loadModelsConfig(projectRoot);
  if (!config?.providers?.[providerName]) return null;

  const provider = config.providers[providerName];
  return {
    ...provider,
    resolvedApiKey: resolveApiKey(provider.apiKey),
  };
}

/**
 * Clear the cached config (useful for testing or config reload)
 */
export function clearModelsConfigCache(): void {
  cachedConfig = null;
  cachedConfigPath = null;
}
