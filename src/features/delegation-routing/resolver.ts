/**
 * Delegation Router
 *
 * Resolves which provider/tool to use for a given agent role.
 */

import type {
  DelegationRoutingConfig,
  DelegationRoute,
  DelegationDecision,
  ResolveDelegationOptions,
  DelegationTool,
} from '../../shared/types.js';
import {
  isDelegationEnabled,
  ROLE_CATEGORY_DEFAULTS,
  normalizeDelegationRole,
} from './types.js';

/**
 * Resolve delegation decision based on configuration and context
 *
 * Precedence (highest to lowest):
 * 1. Explicit tool invocation
 * 2. Configured routing (if enabled)
 * 3. Default heuristic (role category → Claude subagent)
 * 4. defaultProvider
 */
export function resolveDelegation(options: ResolveDelegationOptions): DelegationDecision {
  const { agentRole, explicitTool, explicitModel, config } = options;
  const canonicalAgentRole = normalizeDelegationRole(agentRole);

  // Priority 1: Explicit tool invocation
  if (explicitTool) {
    return resolveExplicitTool(explicitTool, explicitModel, canonicalAgentRole);
  }

  // Priority 2: Configured routing (if enabled)
  const configuredRoute = config?.roles?.[agentRole]
    ?? (canonicalAgentRole !== agentRole ? config?.roles?.[canonicalAgentRole] : undefined);

  if (config && isDelegationEnabled(config) && configuredRoute) {
    return resolveFromConfig(canonicalAgentRole, configuredRoute);
  }

  // Priority 3 & 4: Default heuristic
  return resolveDefault(canonicalAgentRole, config);
}

/**
 * Resolve when user explicitly specified a tool
 */
function resolveExplicitTool(
  tool: DelegationTool,
  model: string | undefined,
  agentRole: string
): DelegationDecision {
  // Only 'Task' is supported - explicit tool invocation always uses Claude
  return {
    provider: 'claude',
    tool: 'Task',
    agentOrModel: agentRole,
    reason: `Explicit tool invocation: ${tool}`,
  };
}

/**
 * Resolve from configuration
 */
function resolveFromConfig(
  agentRole: string,
  route: DelegationRoute,
): DelegationDecision {
  const provider = route.provider;
  let tool = route.tool;

  // Warn and fall back to claude for deprecated codex/gemini providers
  if (provider === 'codex' || provider === 'gemini') {
    console.warn('[OMC] Codex/Gemini MCP delegation is deprecated. Use /team to coordinate CLI workers instead.');
    const agentOrModel = route.model || route.agentType || agentRole;
    const fallbackChain = route.fallback;
    return {
      provider: 'claude',
      tool: 'Task',
      agentOrModel,
      reason: `Configured routing for role "${agentRole}" (deprecated provider "${provider}", falling back to Claude Task)`,
      fallbackChain,
    };
  }

  // Only claude → Task is valid; correct any mismatch
  if (tool !== 'Task') {
    console.warn(`[delegation-routing] Provider/tool mismatch: ${provider} with ${tool}. Correcting to Task.`);
    tool = 'Task';
  }

  const agentOrModel = route.model || route.agentType || agentRole;
  const fallbackChain = route.fallback;

  return {
    provider,
    tool,
    agentOrModel,
    reason: `Configured routing for role "${agentRole}"`,
    fallbackChain,
  };
}

/**
 * Resolve using defaults
 */
function resolveDefault(
  agentRole: string,
  config: DelegationRoutingConfig | undefined
): DelegationDecision {
  // Check if we have a default agent mapping for this role
  const defaultAgent = ROLE_CATEGORY_DEFAULTS[agentRole];

  if (defaultAgent) {
    return {
      provider: 'claude',
      tool: 'Task',
      agentOrModel: defaultAgent,
      reason: `Default heuristic: role "${agentRole}" → Claude subagent "${defaultAgent}"`,
    };
  }

  // Fall back to default provider or claude
  const defaultProvider = config?.defaultProvider || 'claude';

  if (defaultProvider === 'codex' || defaultProvider === 'gemini') {
    console.warn('[OMC] Codex/Gemini MCP delegation is deprecated. Use /team to coordinate CLI workers instead.');
  }

  // Default to claude Task (codex/gemini default providers fall back to claude)
  return {
    provider: 'claude',
    tool: 'Task',
    agentOrModel: agentRole,
    reason: `Fallback to Claude Task for role "${agentRole}"`,
  };
}

/**
 * Parse fallback chain format ["claude:explore", "codex:gpt-5"]
 */
export function parseFallbackChain(
  fallback: string[] | undefined
): Array<{ provider: string; agentOrModel: string }> {
  if (!fallback || fallback.length === 0) {
    return [];
  }

  return fallback
    .map((entry) => {
      const parts = entry.split(':');
      if (parts.length >= 2) {
        const provider = parts[0].trim();
        const agentOrModel = parts.slice(1).join(':').trim(); // Handle cases like "codex:gpt-5.3-codex"
        // Skip entries with empty provider or empty agent/model
        if (provider && agentOrModel) {
          return {
            provider,
            agentOrModel,
          };
        }
      }
      // Invalid format, skip
      return null;
    })
    .filter((item): item is { provider: string; agentOrModel: string } => item !== null);
}
