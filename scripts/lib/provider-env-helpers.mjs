/**
 * Shared helpers for provider environment variable detection.
 * Used by session-start.mjs, pre-tool-enforcer.mjs, and inlined in src/config/models.ts.
 */

/**
 * Parse a provider flag env var that accepts both "1" and "true" (case-insensitive).
 * Returns true only when the value (after trim) equals "1" or "true" (case-insensitive).
 * Empty strings, "0", "false", and null/undefined return false.
 *
 * This matches SessionStart's original behavior: CLAUDE_CODE_USE_BEDROCK=true
 * or CLAUDE_CODE_USE_BEDROCK=1 both enable Bedrock.
 */
export function isTruthyProviderFlag(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}
