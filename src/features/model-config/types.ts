/**
 * Multi-Provider Model Configuration Types
 *
 * Types for `.claude/models.json` configuration that allows assigning
 * specific models from any provider (OpenAI, Gemini, Ollama, etc.)
 * to each agent.
 */

import type { ModelType } from '../../shared/types.js';

/**
 * Provider connection configuration
 */
export interface ProviderConfig {
  /** Base URL for the provider API */
  baseUrl: string;
  /** API key - raw string or "$ENV_VAR" reference */
  apiKey?: string;
  /** Available model IDs for this provider */
  models: string[];
}

/**
 * Per-agent model assignment
 */
export interface AgentModelConfig {
  /** Provider key from providers map, or "claude" for native Claude */
  provider: string;
  /** Model ID (for external providers) or Claude tier name (haiku/sonnet/opus) */
  model: string;
  /** Role hint for MCP delegation (e.g., "architect", "designer") */
  role?: string;
  /** Claude tier fallback if external provider is unavailable */
  fallback?: ModelType;
}

/**
 * Root configuration from .claude/models.json
 */
export interface ModelsConfig {
  /** Provider definitions with connection details */
  providers?: Record<string, ProviderConfig>;
  /** Per-agent model assignments */
  agents?: Record<string, AgentModelConfig>;
  /** Default fallback for agents not listed in agents map */
  defaults?: AgentModelConfig;
}

/**
 * Resolved model ready for execution
 */
export interface ResolvedModel {
  /** Whether this is a native Claude model or external provider */
  type: 'claude' | 'external';
  /** Claude tier (haiku/sonnet/opus) - set for claude type */
  tier?: ModelType;
  /** Provider name - set for external type */
  provider?: string;
  /** Model ID - set for external type */
  model?: string;
  /** Agent role for MCP delegation */
  role?: string;
  /** Resolved base URL for the provider */
  baseUrl?: string;
  /** Resolved API key for the provider */
  apiKey?: string;
  /** Claude tier to fall back to if external provider fails */
  fallbackTier?: ModelType;
}

/**
 * Known provider-to-MCP-tool mapping
 */
export const PROVIDER_MCP_MAPPING: Record<string, string> = {
  openai: 'codex',
  codex: 'codex',
  gemini: 'gemini',
  google: 'gemini',
};

/**
 * Claude tier names for validation
 */
export const CLAUDE_TIERS: readonly string[] = ['haiku', 'sonnet', 'opus'] as const;
