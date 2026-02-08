/**
 * Model Resolution Pipeline
 *
 * Resolves the model to use for a given agent by checking:
 * 1. .claude/models.json agent override
 * 2. .claude/models.json defaults
 * 3. Fall back to existing static tier from definitions.ts
 */

import type { ModelType } from '../../shared/types.js';
import type { ResolvedModel, AgentModelConfig } from './types.js';
import { CLAUDE_TIERS, PROVIDER_MCP_MAPPING } from './types.js';
import { getAgentModelConfig, getResolvedProviderConfig } from './loader.js';

/**
 * Map a Claude tier string to a ModelType
 */
function toModelType(tier: string): ModelType | undefined {
  if (CLAUDE_TIERS.includes(tier)) {
    return tier as ModelType;
  }
  return undefined;
}

/**
 * Determine which MCP tool to use for an external provider
 */
export function getMcpToolForProvider(provider: string): string | undefined {
  return PROVIDER_MCP_MAPPING[provider.toLowerCase()];
}

/**
 * Resolve model config for a specific agent.
 *
 * Resolution order:
 * 1. .claude/models.json agent-specific config
 * 2. .claude/models.json defaults
 * 3. Static tier fallback (passed by caller from definitions.ts)
 */
export function resolveModelForAgent(
  agentName: string,
  staticTier?: ModelType,
  projectRoot?: string,
): ResolvedModel {
  const agentConfig = getAgentModelConfig(agentName, projectRoot);

  // No models.json config found - use static tier
  if (!agentConfig) {
    return {
      type: 'claude',
      tier: staticTier || 'sonnet',
    };
  }

  return resolveFromAgentConfig(agentConfig, staticTier, projectRoot);
}

/**
 * Resolve a ResolvedModel from an AgentModelConfig
 */
function resolveFromAgentConfig(
  agentConfig: AgentModelConfig,
  staticTier?: ModelType,
  projectRoot?: string,
): ResolvedModel {
  // Claude provider - use native tier
  if (agentConfig.provider === 'claude') {
    const tier = toModelType(agentConfig.model);
    return {
      type: 'claude',
      tier: tier || staticTier || 'sonnet',
    };
  }

  // External provider - resolve provider details
  const providerConfig = getResolvedProviderConfig(agentConfig.provider, projectRoot);

  if (!providerConfig) {
    // Provider not found in config - fall back to Claude tier
    const fallback = agentConfig.fallback || staticTier || 'sonnet';
    return {
      type: 'claude',
      tier: fallback,
    };
  }

  return {
    type: 'external',
    provider: agentConfig.provider,
    model: agentConfig.model,
    role: agentConfig.role,
    baseUrl: providerConfig.baseUrl,
    apiKey: providerConfig.resolvedApiKey,
    fallbackTier: agentConfig.fallback || staticTier || 'sonnet',
  };
}

/**
 * Check if an external provider is available (has resolved API key or is local)
 */
export function isProviderAvailable(resolved: ResolvedModel): boolean {
  if (resolved.type === 'claude') return true;

  // Local providers (e.g., Ollama) don't need API keys
  if (resolved.baseUrl?.includes('localhost') || resolved.baseUrl?.includes('127.0.0.1')) {
    return true;
  }

  // Remote providers need an API key
  return !!resolved.apiKey;
}

/**
 * Get the fallback ResolvedModel when external provider is unavailable
 */
export function getFallbackModel(resolved: ResolvedModel): ResolvedModel {
  return {
    type: 'claude',
    tier: resolved.fallbackTier || 'sonnet',
  };
}

/**
 * Resolve model for agent with automatic fallback if provider unavailable
 */
export function resolveModelWithFallback(
  agentName: string,
  staticTier?: ModelType,
  projectRoot?: string,
): ResolvedModel {
  const resolved = resolveModelForAgent(agentName, staticTier, projectRoot);

  if (resolved.type === 'external' && !isProviderAvailable(resolved)) {
    return getFallbackModel(resolved);
  }

  return resolved;
}
