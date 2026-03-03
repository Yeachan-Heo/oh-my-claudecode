import { validateAnthropicBaseUrl } from '../utils/ssrf-guard.js';

/**
 * Centralized Model ID Constants
 *
 * All default model IDs are defined here so they can be overridden
 * via environment variables without editing source code.
 *
 * Environment variables (highest precedence):
 *   OMC_MODEL_HIGH    - Model ID for HIGH tier (opus-class)
 *   OMC_MODEL_MEDIUM  - Model ID for MEDIUM tier (sonnet-class)
 *   OMC_MODEL_LOW     - Model ID for LOW tier (haiku-class)
 *
 * User config (~/.config/claude-omc/config.jsonc) can also override
 * via `routing.tierModels` or per-agent `agents.<name>.model`.
 */

/** Built-in fallback model IDs (used when no env var or config override is set) */
const BUILTIN_MODEL_HIGH = 'claude-opus-4-6-20260205';
const BUILTIN_MODEL_MEDIUM = 'claude-sonnet-4-6-20260217';
const BUILTIN_MODEL_LOW = 'claude-haiku-4-5-20251001';

/**
 * Resolve the default model ID for a tier.
 *
 * Resolution order:
 * 1. Environment variable (OMC_MODEL_HIGH / OMC_MODEL_MEDIUM / OMC_MODEL_LOW)
 * 2. Built-in fallback
 *
 * User/project config overrides are applied later by the config loader
 * via deepMerge, so they take precedence over these defaults.
 */
export function getDefaultModelHigh(): string {
  return process.env.OMC_MODEL_HIGH || BUILTIN_MODEL_HIGH;
}

export function getDefaultModelMedium(): string {
  return process.env.OMC_MODEL_MEDIUM || BUILTIN_MODEL_MEDIUM;
}

export function getDefaultModelLow(): string {
  return process.env.OMC_MODEL_LOW || BUILTIN_MODEL_LOW;
}

/**
 * Get all default tier models as a record.
 * Each call reads current env vars, so changes are reflected immediately.
 */
export function getDefaultTierModels(): Record<'LOW' | 'MEDIUM' | 'HIGH', string> {
  return {
    LOW: getDefaultModelLow(),
    MEDIUM: getDefaultModelMedium(),
    HIGH: getDefaultModelHigh(),
  };
}

/**
 * Detect whether Claude Code is running on AWS Bedrock.
 *
 * Claude Code sets CLAUDE_CODE_USE_BEDROCK=1 when configured for Bedrock.
 * As a fallback, Bedrock model IDs use prefixed formats like:
 *   - us.anthropic.claude-sonnet-4-6-v1:0
 *   - global.anthropic.claude-3-5-sonnet-20241022-v2:0
 *   - anthropic.claude-3-haiku-20240307-v1:0
 *
 * On Bedrock, passing bare tier names (sonnet/opus/haiku) to spawned
 * agents causes 400 errors because the provider expects full Bedrock
 * model IDs with region/inference-profile prefixes.
 */
export function isBedrock(): boolean {
  // Primary signal: Claude Code's own env var
  if (process.env.CLAUDE_CODE_USE_BEDROCK === '1') {
    return true;
  }

  // Fallback: detect Bedrock model ID patterns in CLAUDE_MODEL / ANTHROPIC_MODEL
  // Covers region prefixes (us, eu, ap), cross-region (global), and bare (anthropic.)
  const modelId = process.env.CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || '';
  if (modelId && /^((us|eu|ap|global)\.anthropic\.|anthropic\.claude)/i.test(modelId)) {
    return true;
  }

  return false;
}

/**
 * Detect whether Claude Code is running on Google Vertex AI.
 *
 * Claude Code sets CLAUDE_CODE_USE_VERTEX=1 when configured for Vertex AI.
 * Vertex model IDs typically use a "vertex_ai/" prefix.
 *
 * On Vertex, passing bare tier names causes errors because the provider
 * expects full Vertex model paths.
 */
export function isVertexAI(): boolean {
  if (process.env.CLAUDE_CODE_USE_VERTEX === '1') {
    return true;
  }

  // Fallback: detect vertex_ai/ prefix in model ID
  const modelId = process.env.CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || '';
  if (modelId && modelId.toLowerCase().startsWith('vertex_ai/')) {
    return true;
  }

  return false;
}

/**
 * Detect whether OMC should avoid passing Claude-specific model tier
 * names (sonnet/opus/haiku) to the Agent tool.
 *
 * Returns true when:
 * - User explicitly set OMC_ROUTING_FORCE_INHERIT=true
 * - Running on AWS Bedrock — needs full Bedrock model IDs, not bare tier names
 * - Running on Google Vertex AI — needs full Vertex model paths
 * - A non-Claude model ID is detected (CC Switch, LiteLLM, etc.)
 * - A custom ANTHROPIC_BASE_URL points to a non-Anthropic endpoint
 */
export function isNonClaudeProvider(): boolean {
  // Explicit opt-in: user has already set forceInherit via env var
  if (process.env.OMC_ROUTING_FORCE_INHERIT === 'true') {
    return true;
  }

  // AWS Bedrock: Claude via AWS, but needs full Bedrock model IDs
  if (isBedrock()) {
    return true;
  }

  // Google Vertex AI: Claude via GCP, needs full Vertex model paths
  if (isVertexAI()) {
    return true;
  }

  // Check CLAUDE_MODEL / ANTHROPIC_MODEL for non-Claude model IDs
  // Note: this check comes AFTER Bedrock/Vertex because their model IDs
  // contain "claude" and would incorrectly return false here.
  const modelId = process.env.CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || '';
  if (modelId && !modelId.toLowerCase().includes('claude')) {
    return true;
  }

  // Custom base URL suggests a proxy/gateway (CC Switch, LiteLLM, OneAPI, etc.)
  const baseUrl = process.env.ANTHROPIC_BASE_URL || '';
  if (baseUrl) {
    // Validate URL for SSRF protection
    const validation = validateAnthropicBaseUrl(baseUrl);
    if (!validation.allowed) {
      console.error(`[SSRF Guard] Rejecting ANTHROPIC_BASE_URL: ${validation.reason}`);
      // Treat invalid URLs as non-Claude to prevent potential SSRF
      return true;
    }
    if (!baseUrl.includes('anthropic.com')) {
      return true;
    }
  }

  return false;
}
