/**
 * OMC HUD - Enterprise Cost Element
 *
 * Renders billing-period cumulative spend for Claude Enterprise subscribers.
 * Shows spent:$X,XXX.XX when unlimited, or spent:$X.XX/$Y.YY (Z%) when capped.
 */

import type { RateLimits } from '../types.js';
import { RESET } from '../colors.js';

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';

// Thresholds matching limits.ts for consistency
const WARNING_THRESHOLD = 70;
const CRITICAL_THRESHOLD = 90;

function getColor(percent: number): string {
  if (percent >= CRITICAL_THRESHOLD) return RED;
  if (percent >= WARNING_THRESHOLD) return YELLOW;
  return GREEN;
}

/**
 * Format a monetary amount with thousands-separator commas, honouring the
 * currency's minor-unit exponent (USD/EUR=2, JPY=0, BHD=3).
 * e.g. (3323.93, 2) → "3,323.93"; (50000, 0) → "50,000".
 */
function formatMoney(amount: number, decimals: number): string {
  const [intPart, decPart] = amount.toFixed(decimals).split('.');
  const withCommas = (intPart ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decPart ? `${withCommas}.${decPart}` : withCommas;
}

/**
 * Get currency prefix string.
 * USD → "$", anything else → "KRW " (ISO code + space)
 */
function currencyPrefix(currency: string): string {
  return currency.toUpperCase() === 'USD' ? '$' : `${currency.toUpperCase()} `;
}

/**
 * Render enterprise billing-period cost display.
 *
 * Format (unlimited): spent:$3,323.93
 * Format (capped):    spent:$3.21/$50.00 (7%)   with color on percent
 * Returns null when enterpriseSpentUsd is undefined (API error / no data).
 */
export function renderEnterpriseCost(
  limits: RateLimits | null | undefined,
  stale?: boolean,
): string | null {
  if (!limits || limits.enterpriseSpentUsd === undefined) return null;

  const staleMarker = stale ? `${DIM}*${RESET}` : '';
  const currency = limits.enterpriseCurrency ?? 'USD';
  const prefix = currencyPrefix(currency);
  const decimals = limits.enterpriseDecimalPlaces ?? 2;
  const spentStr = formatMoney(limits.enterpriseSpentUsd, decimals);

  if (limits.enterpriseLimitUsd == null) {
    // Unlimited plan — show spent amount only
    return `${DIM}spent:${RESET}${prefix}${spentStr}${staleMarker}`;
  }

  // Capped plan — show spent/limit (utilization%)
  const limitStr = formatMoney(limits.enterpriseLimitUsd, decimals);
  const utilization = limits.enterpriseUtilization ?? 0;
  const rounded = Math.min(100, Math.max(0, Math.round(utilization)));
  const color = getColor(rounded);

  return `${DIM}spent:${RESET}${prefix}${spentStr}/${prefix}${limitStr} ${color}(${rounded}%)${RESET}${staleMarker}`;
}
