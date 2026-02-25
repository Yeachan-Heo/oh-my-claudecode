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
 * 1. Environment variable (OMC_MODEL_HIGH / OMC_MODEL_MEDIUM / OMC_MODEL_LOW)
 * 2. Built-in fallback
 *
 * User/project config overrides are applied later by the config loader
 * via deepMerge, so they take precedence over these defaults.
 */
export declare function getDefaultModelHigh(): string;
export declare function getDefaultModelMedium(): string;
export declare function getDefaultModelLow(): string;
/**
 * Get all default tier models as a record.
 * Each call reads current env vars, so changes are reflected immediately.
 */
export declare function getDefaultTierModels(): Record<'LOW' | 'MEDIUM' | 'HIGH', string>;
//# sourceMappingURL=models.d.ts.map