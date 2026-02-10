/**
 * External Model Policy - Resolver for MCP provider model selection
 *
 * This module provides a pure function to resolve which external model (Codex/Gemini)
 * to use based on agent role, task type, and user configuration.
 */
// Fallback chain constants
export const CODEX_MODEL_FALLBACKS = [
    'gpt-5.3-codex',
    'gpt-5.3',
    'gpt-5.2-codex',
    'gpt-5.2',
];
export const GEMINI_MODEL_FALLBACKS = [
    'gemini-3-pro-preview',
    'gemini-3-flash-preview',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
];
// Hardcoded defaults (from codex-core.ts and gemini-core.ts)
const HARDCODED_DEFAULTS = {
    codex: 'gpt-5.3-codex',
    gemini: 'gemini-3-pro-preview',
};
// Default fallback policy
const DEFAULT_FALLBACK_POLICY = {
    onModelFailure: 'provider_chain',
    allowCrossProvider: false,
    crossProviderOrder: ['codex', 'gemini'],
};
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
export function resolveExternalModel(config, options) {
    const { agentRole, taskType, explicitProvider, explicitModel } = options;
    // Precedence 1: explicitModel argument - if provided, determine provider from model name
    if (explicitModel) {
        const provider = guessProviderFromModel(explicitModel);
        return {
            provider,
            model: explicitModel,
            fallbackPolicy: config?.fallbackPolicy ?? DEFAULT_FALLBACK_POLICY,
        };
    }
    // Precedence 2: explicitProvider + matching role preference
    if (explicitProvider && agentRole && config?.rolePreferences?.[agentRole]) {
        const rolePref = config.rolePreferences[agentRole];
        if (rolePref.provider === explicitProvider) {
            return {
                provider: explicitProvider,
                model: rolePref.model,
                fallbackPolicy: config?.fallbackPolicy ?? DEFAULT_FALLBACK_POLICY,
            };
        }
    }
    // Precedence 3: taskPreferences[taskType]
    if (taskType && config?.taskPreferences?.[taskType]) {
        const taskPref = config.taskPreferences[taskType];
        return {
            provider: taskPref.provider,
            model: taskPref.model,
            fallbackPolicy: config?.fallbackPolicy ?? DEFAULT_FALLBACK_POLICY,
        };
    }
    // Precedence 4: rolePreferences[agentRole]
    if (agentRole && config?.rolePreferences?.[agentRole]) {
        const rolePref = config.rolePreferences[agentRole];
        return {
            provider: rolePref.provider,
            model: rolePref.model,
            fallbackPolicy: config?.fallbackPolicy ?? DEFAULT_FALLBACK_POLICY,
        };
    }
    // Precedence 5-7: Determine provider and get default model
    const provider = explicitProvider ?? config?.defaults?.provider ?? 'codex';
    const model = getDefaultModelForProvider(provider, config);
    return {
        provider,
        model,
        fallbackPolicy: config?.fallbackPolicy ?? DEFAULT_FALLBACK_POLICY,
    };
}
/**
 * Guess provider from model name
 */
function guessProviderFromModel(model) {
    const lowerModel = model.toLowerCase();
    if (lowerModel.includes('gemini')) {
        return 'gemini';
    }
    // Default to codex for gpt-*, claude*, or unknown models
    return 'codex';
}
/**
 * Get provider-specific default model
 *
 * Precedence:
 * 1. defaults.{codexModel,geminiModel} in config
 * 2. Environment variables (OMC_CODEX_DEFAULT_MODEL, OMC_GEMINI_DEFAULT_MODEL)
 * 3. Hardcoded defaults
 */
function getDefaultModelForProvider(provider, config) {
    // Precedence 5: defaults in config
    if (provider === 'codex' && config?.defaults?.codexModel) {
        return config.defaults.codexModel;
    }
    if (provider === 'gemini' && config?.defaults?.geminiModel) {
        return config.defaults.geminiModel;
    }
    // Precedence 6: Environment variables
    if (provider === 'codex') {
        const envModel = process.env.OMC_CODEX_DEFAULT_MODEL;
        if (envModel) {
            return envModel;
        }
    }
    if (provider === 'gemini') {
        const envModel = process.env.OMC_GEMINI_DEFAULT_MODEL;
        if (envModel) {
            return envModel;
        }
    }
    // Precedence 7: Hardcoded defaults
    return HARDCODED_DEFAULTS[provider];
}
/**
 * Build deduplicated fallback chain for a provider
 */
export function buildFallbackChain(provider, resolvedModel, config) {
    const defaultChain = provider === 'codex' ? CODEX_MODEL_FALLBACKS : GEMINI_MODEL_FALLBACKS;
    // Combine resolved model with default chain, removing duplicates
    const chain = [resolvedModel, ...defaultChain];
    return [...new Set(chain)];
}
//# sourceMappingURL=external-model-policy.js.map