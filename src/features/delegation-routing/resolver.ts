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
  DelegationProvider,
  DelegationTool,
} from '../../shared/types.js';
import { isDelegationEnabled, ROLE_CATEGORY_DEFAULTS } from './types.js';

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

  // Priority 1: Explicit tool invocation
  if (explicitTool) {
    return resolveExplicitTool(explicitTool, explicitModel, agentRole);
  }

  // Priority 2: Configured routing (if enabled)
  if (isDelegationEnabled(config) && config?.roles?.[agentRole]) {
    return resolveFromConfig(agentRole, config.roles[agentRole], config);
  }

  // Priority 3 & 4: Default heuristic
  return resolveDefault(agentRole, config);
}

/**
 * Resolve when user explicitly specified a tool
 */
function resolveExplicitTool(
  tool: DelegationTool,
  model: string | undefined,
  agentRole: string
): DelegationDecision {
  // Map tool to provider and model
  let provider: DelegationProvider;
  let agentOrModel: string;

  switch (tool) {
    case 'ask_codex':
      provider = 'codex';
      agentOrModel = model || 'gpt-5.3-codex';
      break;
    case 'ask_gemini':
      provider = 'gemini';
      // Keep default consistent with Gemini core + external-model policy
      agentOrModel = model || 'gemini-3-pro-preview';
      break;
    case 'Task':
    default:
      provider = 'claude';
      agentOrModel = agentRole;
      break;
  }

  return {
    provider,
    tool,
    agentOrModel,
    reason: `Explicit tool invocation: ${tool}`,
  };
}

/**
 * Resolve from configuration
 */
function resolveFromConfig(
  agentRole: string,
  route: DelegationRoute,
  config: DelegationRoutingConfig
): DelegationDecision {
  let provider = route.provider;
  let tool = route.tool;

  // Validate provider matches tool
  const validCombinations: Record<string, DelegationTool> = {
    claude: 'Task',
    codex: 'ask_codex',
    gemini: 'ask_gemini',
  };

  if (validCombinations[provider] !== tool) {
    console.warn(`[delegation-routing] Provider/tool mismatch: ${provider} with ${tool}. Correcting to ${validCombinations[provider]}.`);
    tool = validCombinations[provider];
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

  if (defaultProvider === 'codex') {
    return {
      provider: 'codex',
      tool: 'ask_codex',
      agentOrModel: 'gpt-5.3-codex',
      reason: `Fallback to default provider: ${defaultProvider}`,
    };
  }

  if (defaultProvider === 'gemini') {
    return {
      provider: 'gemini',
      tool: 'ask_gemini',
      agentOrModel: 'gemini-3-pro-preview',
      reason: `Fallback to default provider: ${defaultProvider}`,
    };
  }

  // Default to claude Task
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
