/**
 * Model Config Feature
 *
 * Multi-provider model configuration via `.claude/models.json`.
 * Allows assigning specific models from any provider to each agent.
 *
 * Usage:
 * ```typescript
 * import { resolveModelForAgent, resolveModelWithFallback } from './model-config';
 *
 * const resolved = resolveModelWithFallback('architect', 'opus');
 * if (resolved.type === 'external') {
 *   // Delegate via MCP tool (ask_codex / ask_gemini)
 * } else {
 *   // Use Claude Task tool with resolved.tier
 * }
 * ```
 */

// Types
export type {
  ProviderConfig,
  AgentModelConfig,
  ModelsConfig,
  ResolvedModel,
} from './types.js';

export {
  PROVIDER_MCP_MAPPING,
  CLAUDE_TIERS,
} from './types.js';

// Loader
export {
  getModelsConfigPath,
  resolveApiKey,
  loadModelsConfigFromFile,
  validateConfig,
  loadModelsConfig,
  getAgentModelConfig,
  getResolvedProviderConfig,
  clearModelsConfigCache,
} from './loader.js';

// Resolver
export {
  getMcpToolForProvider,
  resolveModelForAgent,
  isProviderAvailable,
  getFallbackModel,
  resolveModelWithFallback,
} from './resolver.js';
