/**
 * OMC HUD - Cost Element
 *
 * Renders estimated cost based on token usage × Anthropic published pricing.
 * Prices are per million tokens ($/MTok), updated for Claude 4 family.
 */

import { dim } from '../colors.js';

/** Anthropic pricing table — $/MTok (input, output) */
const PRICE_TABLE: Record<string, [number, number]> = {
  // Claude 4 family
  'claude-opus-4-5':                  [15,   75],
  'claude-opus-4-6':                  [15,   75],
  'claude-sonnet-4-5':                [3,    15],
  'claude-sonnet-4-6':                [3,    15],
  'claude-haiku-4-5':                 [0.80, 4],
  'claude-haiku-4-5-20251001':        [0.80, 4],
  // Claude 3 family (fallback)
  'claude-opus-3':                    [15,   75],
  'claude-sonnet-3-5':                [3,    15],
  'claude-haiku-3':                   [0.25, 1.25],
};

/** Resolve price for a model ID. Returns [inputPerMTok, outputPerMTok] or null. */
function resolvePrice(modelId: string): [number, number] | null {
  // Exact match first
  if (PRICE_TABLE[modelId]) return PRICE_TABLE[modelId];
  // Prefix match (e.g. "claude-sonnet-4-6-20251022" → "claude-sonnet-4-6")
  for (const key of Object.keys(PRICE_TABLE)) {
    if (modelId.startsWith(key)) return PRICE_TABLE[key];
  }
  return null;
}

/** Calculate cost in USD from token counts and model id. Returns null if model unknown. */
export function calculateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number
): number | null {
  const price = resolvePrice(modelId);
  if (!price) return null;
  return (inputTokens * price[0] + outputTokens * price[1]) / 1_000_000;
}

/**
 * Format a USD cost value.
 * < $0.01 → "$0.00x" (3 sig figs)
 * >= $0.01 → "$0.02"
 * >= $1 → "$1.23"
 */
function formatUsd(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4).replace(/0+$/, '').replace(/\.$/, '.0')}`;
  if (usd < 1)    return `$${usd.toFixed(3).replace(/0+$/, '').replace(/\.$/, '.0')}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Render cost display.
 *
 * Format: $0.02  (request only)
 *         $0.02/sess:$1.23  (request + session)
 */
export function renderCost(
  requestCostUsd: number | null,
  sessionCostUsd: number | null
): string | null {
  if (requestCostUsd === null) return null;
  const reqStr = formatUsd(requestCostUsd);
  if (sessionCostUsd !== null && sessionCostUsd > 0) {
    return `${reqStr}${dim('/')}${dim('sess:')}${formatUsd(sessionCostUsd)}`;
  }
  return reqStr;
}
