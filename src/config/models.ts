import { validateAnthropicBaseUrl } from '../utils/ssrf-guard.js';

export type ModelTier = 'LOW' | 'MEDIUM' | 'HIGH';
export type ClaudeModelFamily = 'HAIKU' | 'SONNET' | 'OPUS';

const DIRECT_MODEL_ENV_KEYS = ['CLAUDE_MODEL', 'ANTHROPIC_MODEL'] as const;
const INHERIT_TIER_PRIORITY: readonly ModelTier[] = ['MEDIUM', 'HIGH', 'LOW'];
const CLAUDE_TIER_ALIASES = new Set(['sonnet', 'opus', 'haiku']);

const TIER_ENV_KEYS: Record<ModelTier, readonly string[]> = {
  LOW: [
    'OMC_MODEL_LOW',
    'CLAUDE_CODE_BEDROCK_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  ],
  MEDIUM: [
    'OMC_MODEL_MEDIUM',
    'CLAUDE_CODE_BEDROCK_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
  ],
  HIGH: [
    'OMC_MODEL_HIGH',
    'CLAUDE_CODE_BEDROCK_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
  ],
};

/**
 * Canonical Claude family defaults.
 * Keep these date-less so version bumps are a one-line edit per family.
 */
export const CLAUDE_FAMILY_DEFAULTS: Record<ClaudeModelFamily, string> = {
  HAIKU: 'claude-haiku-4-5',
  SONNET: 'claude-sonnet-4-6',
  OPUS: 'claude-opus-4-7',
};

/** Canonical tier->model mapping used as built-in defaults */
export const BUILTIN_TIER_MODEL_DEFAULTS: Record<ModelTier, string> = {
  LOW: CLAUDE_FAMILY_DEFAULTS.HAIKU,
  MEDIUM: CLAUDE_FAMILY_DEFAULTS.SONNET,
  HIGH: CLAUDE_FAMILY_DEFAULTS.OPUS,
};

/** Canonical Claude high-reasoning variants by family */
export const CLAUDE_FAMILY_HIGH_VARIANTS: Record<ClaudeModelFamily, string> = {
  HAIKU: `${CLAUDE_FAMILY_DEFAULTS.HAIKU}-high`,
  SONNET: `${CLAUDE_FAMILY_DEFAULTS.SONNET}-high`,
  OPUS: `${CLAUDE_FAMILY_DEFAULTS.OPUS}-high`,
};

/** Built-in defaults for external provider models */
export const BUILTIN_EXTERNAL_MODEL_DEFAULTS = {
  codexModel: 'gpt-5.3-codex',
  geminiModel: 'gemini-3.1-pro-preview',
} as const;

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

/**
 * Resolve the default model ID for a tier.
 *
 * Resolution order:
 * 1. OMC tier env vars (OMC_MODEL_HIGH / OMC_MODEL_MEDIUM / OMC_MODEL_LOW)
 * 2. Claude Code provider env vars (for example Bedrock app-profile model IDs)
 * 3. Anthropic family-default env vars
 * 4. Built-in fallback
 *
 * User/project config overrides are applied later by the config loader
 * via deepMerge, so they take precedence over these defaults.
 */
function readEnvValue(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value || undefined;
}

function resolveTierModelFromEnv(tier: ModelTier): string | undefined {
  for (const key of TIER_ENV_KEYS[tier]) {
    const value = readEnvValue(key);
    if (value) {
      return value;
    }
  }

  return undefined;
}

function getDirectModelEnvValue(): string | undefined {
  for (const key of DIRECT_MODEL_ENV_KEYS) {
    const value = readEnvValue(key);
    if (value) {
      return value;
    }
  }

  return undefined;
}

function getProviderDetectionModelEnvValues(): string[] {
  const directModel = getDirectModelEnvValue();
  if (directModel) {
    return [directModel];
  }

  const values = new Set<string>();
  for (const tier of INHERIT_TIER_PRIORITY) {
    const value = resolveTierModelFromEnv(tier);
    if (value) {
      values.add(value);
    }
  }

  return [...values];
}

function getDirectProviderDetectionModelEnvValues(): string[] {
  const directModel = getDirectModelEnvValue();
  return directModel ? [directModel] : [];
}

export function resolveInheritedModelFromEnv(): string | undefined {
  const directModel = getDirectModelEnvValue();
  if (directModel) {
    return directModel;
  }

  for (const tier of INHERIT_TIER_PRIORITY) {
    const value = resolveTierModelFromEnv(tier);
    if (value) {
      return value;
    }
  }

  return undefined;
}

export function hasTierModelEnvOverrides(): boolean {
  return Object.values(TIER_ENV_KEYS).some((keys) =>
    keys.some((key) => {
      return Boolean(readEnvValue(key));
    })
  );
}

export function getDefaultModelHigh(): string {
  return resolveTierModelFromEnv('HIGH') || BUILTIN_TIER_MODEL_DEFAULTS.HIGH;
}

export function getDefaultModelMedium(): string {
  return resolveTierModelFromEnv('MEDIUM') || BUILTIN_TIER_MODEL_DEFAULTS.MEDIUM;
}

export function getDefaultModelLow(): string {
  return resolveTierModelFromEnv('LOW') || BUILTIN_TIER_MODEL_DEFAULTS.LOW;
}

/**
 * Get all default tier models as a record.
 * Each call reads current env vars, so changes are reflected immediately.
 */
export function getDefaultTierModels(): Record<ModelTier, string> {
  return {
    LOW: getDefaultModelLow(),
    MEDIUM: getDefaultModelMedium(),
    HIGH: getDefaultModelHigh(),
  };
}

/**
 * Resolve a Claude family from an arbitrary model ID.
 * Supports Anthropic IDs and provider-prefixed forms (e.g. vertex_ai/...).
 */
export function resolveClaudeFamily(modelId: string): ClaudeModelFamily | null {
  const lower = modelId.toLowerCase();
  if (!lower.includes('claude')) return null;

  if (lower.includes('sonnet')) return 'SONNET';
  if (lower.includes('opus')) return 'OPUS';
  if (lower.includes('haiku')) return 'HAIKU';

  return null;
}

/**
 * Resolve a canonical Claude high variant from a Claude model ID.
 * Returns null for non-Claude model IDs.
 */
export function getClaudeHighVariantFromModel(modelId: string): string | null {
  const family = resolveClaudeFamily(modelId);
  return family ? CLAUDE_FAMILY_HIGH_VARIANTS[family] : null;
}

/** Get built-in default model for an external provider */
export function getBuiltinExternalDefaultModel(provider: 'codex' | 'gemini'): string {
  return provider === 'codex'
    ? BUILTIN_EXTERNAL_MODEL_DEFAULTS.codexModel
    : BUILTIN_EXTERNAL_MODEL_DEFAULTS.geminiModel;
}


function hasBedrockModelId(modelIds: readonly string[]): boolean {
  for (const modelId of modelIds) {
    if (/^((us|eu|ap|global)\.anthropic\.|anthropic\.claude)/i.test(modelId)) {
      return true;
    }
    if (
      /^arn:aws(-[^:]+)?:bedrock:/i.test(modelId)
      && /:(inference-profile|application-inference-profile)\//i.test(modelId)
      && modelId.toLowerCase().includes('claude')
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Detect whether Claude Code is running on AWS Bedrock.
 *
 * Claude Code sets CLAUDE_CODE_USE_BEDROCK=1 when configured for Bedrock.
 * As a fallback, Bedrock model IDs use prefixed formats like:
 *   - us.anthropic.claude-sonnet-4-6-v1:0
 *   - global.anthropic.claude-sonnet-4-6-v1:0
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

  // Fallback: detect Bedrock model ID patterns in the active model env value.
  // Direct session model env vars win over lower-precedence tier defaults, so a
  // stale tier/default env must not mark a standard Claude session as Bedrock.
  // Covers region prefixes (us, eu, ap), cross-region (global), and bare (anthropic.)
  return hasBedrockModelId(getProviderDetectionModelEnvValues());
}

/**
 * Check whether a model ID is a provider-specific identifier that should NOT
 * be normalized to a bare alias (sonnet/opus/haiku).
 *
 * Provider-specific IDs include:
 *   - Bedrock prefixed: us.anthropic.claude-*, global.anthropic.claude-*, anthropic.claude-*
 *   - Bedrock ARN: arn:aws:bedrock:...
 *   - Vertex AI: vertex_ai/...
 *
 * These IDs must be passed through to the CLI as-is because normalizing them
 * to aliases like "sonnet" causes Claude Code to expand them to Anthropic API
 * model names (e.g. claude-sonnet-4-6) which are invalid on Bedrock/Vertex.
 */
export function isProviderSpecificModelId(modelId: string): boolean {
  // Bedrock prefixed formats (region.anthropic.claude-*, anthropic.claude-*)
  if (/^((us|eu|ap|global)\.anthropic\.|anthropic\.claude)/i.test(modelId)) {
    return true;
  }
  // Bedrock ARN formats
  if (/^arn:aws(-[^:]+)?:bedrock:/i.test(modelId)) {
    return true;
  }
  // Vertex AI prefixed format
  if (modelId.toLowerCase().startsWith('vertex_ai/')) {
    return true;
  }
  return false;
}

/**
 * Detect whether a model ID has a Claude Code extended-context window suffix
 * (e.g., `[1m]`, `[200k]`) that is NOT a valid Bedrock API identifier.
 *
 * The `[1m]` suffix is a Claude Code internal annotation for the 1M context
 * window variant. It is valid for the parent session's API path but is
 * rejected by the sub-agent spawning runtime, which strips it to a bare
 * Anthropic model ID (e.g., `claude-sonnet-4-6`) that is invalid on Bedrock.
 */
export function hasExtendedContextSuffix(modelId: string): boolean {
  return /\[\d+[mk]\]$/i.test(modelId);
}

/**
 * Check whether a model ID is safe to pass as the `model` parameter when
 * spawning sub-agents on non-standard providers (Bedrock, Vertex AI).
 *
 * A model ID is sub-agent safe if it is provider-specific (full Bedrock or
 * Vertex AI format) AND does not carry a Claude Code context-window suffix
 * like `[1m]` that the sub-agent runtime cannot handle.
 */
export function isSubagentSafeModelId(modelId: string): boolean {
  return isProviderSpecificModelId(modelId) && !hasExtendedContextSuffix(modelId);
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

  // Fallback: detect vertex_ai/ prefix in the active model env value.
  return hasVertexModelId(getProviderDetectionModelEnvValues());
}

function hasVertexModelId(modelIds: readonly string[]): boolean {
  return modelIds.some((modelId) => modelId.toLowerCase().startsWith('vertex_ai/'));
}

function hasNonClaudeModelId(modelIds: readonly string[]): boolean {
  for (const modelId of modelIds) {
    const lower = modelId.toLowerCase();
    if (!lower.includes('claude') && !CLAUDE_TIER_ALIASES.has(lower)) {
      return true;
    }
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

  // Check the active model env value for non-Claude model IDs.
  // Direct CLAUDE_MODEL/ANTHROPIC_MODEL env vars intentionally short-circuit
  // lower-precedence tier defaults so stale tier envs do not force inheritance.
  // Note: this check comes AFTER Bedrock/Vertex because their model IDs
  // contain "claude" and would incorrectly return false here.
  if (hasNonClaudeModelId(getProviderDetectionModelEnvValues())) {
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

/**
 * Detect whether provider state should globally force Agent/Task calls to
 * inherit the parent session model. Tier model env overrides intentionally do
 * not trigger this by themselves: they are configured per-tier defaults for
 * OMC routing, not proof that every delegated agent should drop its model.
 */
export function shouldAutoForceInherit(): boolean {
  if (process.env.OMC_ROUTING_FORCE_INHERIT === 'true') {
    return true;
  }

  if (process.env.CLAUDE_CODE_USE_BEDROCK === '1') {
    return true;
  }

  if (process.env.CLAUDE_CODE_USE_VERTEX === '1') {
    return true;
  }

  const directModelValues = getDirectProviderDetectionModelEnvValues();
  if (
    hasBedrockModelId(directModelValues)
    || hasVertexModelId(directModelValues)
    || hasNonClaudeModelId(directModelValues)
  ) {
    return true;
  }

  const baseUrl = process.env.ANTHROPIC_BASE_URL || '';
  if (baseUrl) {
    const validation = validateAnthropicBaseUrl(baseUrl);
    if (!validation.allowed) {
      console.error(`[SSRF Guard] Rejecting ANTHROPIC_BASE_URL: ${validation.reason}`);
      return true;
    }
    if (!baseUrl.includes('anthropic.com')) {
      return true;
    }
  }

  return false;
}
