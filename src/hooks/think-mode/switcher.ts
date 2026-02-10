/**
 * Think Mode Switcher
 *
 * Handles model switching to high-reasoning variants when think mode is activated.
 * Supports Claude, GPT, and Gemini model families.
 *
 * Ported from oh-my-opencode's think-mode hook.
 */

import type { ThinkingConfig } from './types.js';

/**
 * Extract provider prefix from model ID.
 * Custom providers may use prefixes like vertex_ai/, openai/.
 */
function extractModelPrefix(modelId: string): { prefix: string; base: string } {
  const slashIndex = modelId.indexOf('/');
  if (slashIndex === -1) {
    return { prefix: '', base: modelId };
  }
  return {
    prefix: modelId.slice(0, slashIndex + 1),
    base: modelId.slice(slashIndex + 1),
  };
}

/**
 * Normalize model ID to use consistent hyphen formatting.
 * Handles version numbers like 4.5 → 4-5.
 */
function normalizeModelId(modelId: string): string {
  return modelId.replace(/\.(\d+)/g, '-$1');
}

/**
 * Map of model IDs to their high-reasoning variants.
 */
const HIGH_VARIANT_MAP: Record<string, string> = {
  // Claude
  'claude-sonnet-4-5': 'claude-sonnet-4-5-high',
  'claude-opus-4-6': 'claude-opus-4-6-high',
  'claude-3-5-sonnet': 'claude-3-5-sonnet-high',
  'claude-3-opus': 'claude-3-opus-high',
  // GPT-4
  'gpt-4': 'gpt-4-high',
  'gpt-4-turbo': 'gpt-4-turbo-high',
  'gpt-4o': 'gpt-4o-high',
  // GPT-5
  'gpt-5': 'gpt-5-high',
  'gpt-5-mini': 'gpt-5-mini-high',
  // Gemini
  'gemini-2-pro': 'gemini-2-pro-high',
  'gemini-3-pro': 'gemini-3-pro-high',
  'gemini-3-flash': 'gemini-3-flash-high',
};

/** Set of models already in high variant */
const ALREADY_HIGH: Set<string> = new Set(Object.values(HIGH_VARIANT_MAP));

/**
 * Provider-specific thinking configurations.
 */
export const THINKING_CONFIGS: Record<string, ThinkingConfig> = {
  anthropic: {
    thinking: {
      type: 'enabled',
      budgetTokens: 64000,
    },
    maxTokens: 128000,
  },
  'amazon-bedrock': {
    reasoningConfig: {
      type: 'enabled',
      budgetTokens: 32000,
    },
    maxTokens: 64000,
  },
  google: {
    providerOptions: {
      google: {
        thinkingConfig: {
          thinkingLevel: 'HIGH',
        },
      },
    },
  },
  openai: {
    reasoning_effort: 'high',
  },
};

/**
 * Models capable of thinking mode by provider.
 */
const THINKING_CAPABLE_MODELS: Record<string, readonly string[]> = {
  anthropic: ['claude-sonnet-4', 'claude-opus-4', 'claude-3'],
  'amazon-bedrock': ['claude', 'anthropic'],
  google: ['gemini-2', 'gemini-3'],
  openai: ['gpt-4', 'gpt-5', 'o1', 'o3'],
};

/**
 * Get the high-reasoning variant for a model ID.
 * Returns null if already high or no variant exists.
 */
export function getHighVariant(modelId: string): string | null {
  const normalized = normalizeModelId(modelId);
  const { prefix, base } = extractModelPrefix(normalized);

  // Check if already high variant
  if (ALREADY_HIGH.has(base) || base.endsWith('-high')) {
    return null;
  }

  // Look up high variant
  const highBase = HIGH_VARIANT_MAP[base];
  if (!highBase) {
    return null;
  }

  // Preserve prefix in the high variant
  return prefix + highBase;
}

/**
 * Check if a model is already in high variant mode.
 */
export function isAlreadyHighVariant(modelId: string): boolean {
  const normalized = normalizeModelId(modelId);
  const { base } = extractModelPrefix(normalized);
  return ALREADY_HIGH.has(base) || base.endsWith('-high');
}

/**
 * Resolve proxy providers to their underlying provider.
 */
function resolveProvider(providerId: string, modelId: string): string {
  // GitHub Copilot is a proxy - infer actual provider from model name
  if (providerId === 'github-copilot') {
    const modelLower = modelId.toLowerCase();
    if (modelLower.includes('claude')) return 'anthropic';
    if (modelLower.includes('gemini')) return 'google';
    if (modelLower.includes('gpt') || modelLower.includes('o1') || modelLower.includes('o3')) {
      return 'openai';
    }
  }
  return providerId;
}

/**
 * Check if provider has thinking configuration.
 */
function isThinkingProvider(provider: string): provider is keyof typeof THINKING_CONFIGS {
  return provider in THINKING_CONFIGS;
}

/**
 * Get the thinking configuration for a provider and model.
 * Returns null if not supported or already in high mode.
 */
export function getThinkingConfig(
  providerId: string,
  modelId: string
): ThinkingConfig | null {
  const normalized = normalizeModelId(modelId);
  const { base } = extractModelPrefix(normalized);

  if (isAlreadyHighVariant(normalized)) {
    return null;
  }

  const resolvedProvider = resolveProvider(providerId, modelId);

  if (!isThinkingProvider(resolvedProvider)) {
    return null;
  }

  const config = THINKING_CONFIGS[resolvedProvider];
  const capablePatterns = THINKING_CAPABLE_MODELS[resolvedProvider];

  if (!capablePatterns) {
    return null;
  }

  // Check capability using base model name
  const baseLower = base.toLowerCase();
  const isCapable = capablePatterns.some((pattern) =>
    baseLower.includes(pattern.toLowerCase())
  );

  return isCapable ? config : null;
}

/**
 * Get Claude-specific thinking configuration.
 * This is used by Claude Code for extended thinking.
 */
export function getClaudeThinkingConfig(budgetTokens: number = 64000) {
  return {
    thinking: {
      type: 'enabled' as const,
      budgetTokens,
    },
    maxTokens: 128000,
  };
}
