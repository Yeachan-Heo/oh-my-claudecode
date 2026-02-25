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
export function getDefaultModelHigh() {
    return process.env.OMC_MODEL_HIGH || BUILTIN_MODEL_HIGH;
}
export function getDefaultModelMedium() {
    return process.env.OMC_MODEL_MEDIUM || BUILTIN_MODEL_MEDIUM;
}
export function getDefaultModelLow() {
    return process.env.OMC_MODEL_LOW || BUILTIN_MODEL_LOW;
}
/**
 * Get all default tier models as a record.
 * Each call reads current env vars, so changes are reflected immediately.
 */
export function getDefaultTierModels() {
    return {
        LOW: getDefaultModelLow(),
        MEDIUM: getDefaultModelMedium(),
        HIGH: getDefaultModelHigh(),
    };
}
//# sourceMappingURL=models.js.map