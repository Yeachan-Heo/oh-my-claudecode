/**
 * External Model Policy - Resolver for MCP provider model selection
 *
 * This module provides a pure function to resolve which external model (Codex/Gemini)
 * to use based on agent role, task type, and user configuration.
 */
import type { ExternalModelProvider, ExternalModelsConfig, ResolveOptions, ResolvedModel } from '../../shared/types.js';
export declare const CODEX_MODEL_FALLBACKS: string[];
export declare const GEMINI_MODEL_FALLBACKS: string[];
/**
 * Resolve external model based on configuration and context
 *
 * Precedence (highest to lowest):
 * 1. explicitModel argument
 * 2. explicitProvider + matching role preference
 * 3. taskPreferences[taskType]
 * 4. rolePreferences[agentRole]
 * 5. defaults.{codexModel,geminiModel}
 * 6. Environment variables (OMC_CODEX_DEFAULT_MODEL, OMC_GEMINI_DEFAULT_MODEL)
 * 7. Hardcoded defaults
 */
export declare function resolveExternalModel(config: ExternalModelsConfig | undefined, options: ResolveOptions): ResolvedModel;
/**
 * Build deduplicated fallback chain for a provider
 */
export declare function buildFallbackChain(provider: ExternalModelProvider, resolvedModel: string, config?: ExternalModelsConfig): string[];
//# sourceMappingURL=external-model-policy.d.ts.map