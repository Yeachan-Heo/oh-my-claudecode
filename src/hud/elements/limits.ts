/**
 * OMC HUD - Rate Limits Element
 *
 * Renders 5-hour and weekly rate limit usage display (built-in providers),
 * and custom rate limit buckets from the rateLimitsProvider command.
 */

import type { RateLimits, CustomProviderResult, CustomBucketUsage } from '../types.js';
import { RESET } from '../colors.js';

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';

// Thresholds for rate limit warnings
const WARNING_THRESHOLD = 70;
const CRITICAL_THRESHOLD = 90;

/**
 * Get color based on percentage
 */
function getColor(percent: number): string {
  if (percent >= CRITICAL_THRESHOLD) {
    return RED;
  } else if (percent >= WARNING_THRESHOLD) {
    return YELLOW;
  }
  return GREEN;
}

/**
 * Format reset time as human-readable duration.
 * Returns null if date is null/undefined or in the past.
 */
function formatResetTime(date: Date | null | undefined): string | null {
  if (!date) return null;

  const now = Date.now();
  const resetMs = date.getTime();
  const diffMs = resetMs - now;

  // Already reset or invalid
  if (diffMs <= 0) return null;

  const diffMinutes = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) {
    const remainingHours = diffHours % 24;
    return `${diffDays}d${remainingHours}h`;
  }

  const remainingMinutes = diffMinutes % 60;
  return `${diffHours}h${remainingMinutes}m`;
}

/**
 * Render rate limits display.
 *
 * Format: 5h:45%(3h42m) wk:12%(2d5h) mo:8%(15d3h)
 */
export function renderRateLimits(limits: RateLimits | null): string | null {
  if (!limits) return null;

  const fiveHour = Math.min(100, Math.max(0, Math.round(limits.fiveHourPercent)));
  const fiveHourColor = getColor(fiveHour);
  const fiveHourReset = formatResetTime(limits.fiveHourResetsAt);

  const fiveHourPart = fiveHourReset
    ? `5h:${fiveHourColor}${fiveHour}%${RESET}${DIM}(${fiveHourReset})${RESET}`
    : `5h:${fiveHourColor}${fiveHour}%${RESET}`;

  const parts = [fiveHourPart];

  if (limits.weeklyPercent != null) {
    const weekly = Math.min(100, Math.max(0, Math.round(limits.weeklyPercent)));
    const weeklyColor = getColor(weekly);
    const weeklyReset = formatResetTime(limits.weeklyResetsAt);

    const weeklyPart = weeklyReset
      ? `${DIM}wk:${RESET}${weeklyColor}${weekly}%${RESET}${DIM}(${weeklyReset})${RESET}`
      : `${DIM}wk:${RESET}${weeklyColor}${weekly}%${RESET}`;

    parts.push(weeklyPart);
  }

  if (limits.monthlyPercent != null) {
    const monthly = Math.min(100, Math.max(0, Math.round(limits.monthlyPercent)));
    const monthlyColor = getColor(monthly);
    const monthlyReset = formatResetTime(limits.monthlyResetsAt);

    const monthlyPart = monthlyReset
      ? `${DIM}mo:${RESET}${monthlyColor}${monthly}%${RESET}${DIM}(${monthlyReset})${RESET}`
      : `${DIM}mo:${RESET}${monthlyColor}${monthly}%${RESET}`;

    parts.push(monthlyPart);
  }

  return parts.join(' ');
}

/**
 * Render compact rate limits (just percentages).
 *
 * Format: 45%/12% or 45%/12%/8% (with monthly)
 */
export function renderRateLimitsCompact(limits: RateLimits | null): string | null {
  if (!limits) return null;

  const fiveHour = Math.min(100, Math.max(0, Math.round(limits.fiveHourPercent)));
  const fiveHourColor = getColor(fiveHour);

  const parts = [`${fiveHourColor}${fiveHour}%${RESET}`];

  if (limits.weeklyPercent != null) {
    const weekly = Math.min(100, Math.max(0, Math.round(limits.weeklyPercent)));
    const weeklyColor = getColor(weekly);
    parts.push(`${weeklyColor}${weekly}%${RESET}`);
  }

  if (limits.monthlyPercent != null) {
    const monthly = Math.min(100, Math.max(0, Math.round(limits.monthlyPercent)));
    const monthlyColor = getColor(monthly);
    parts.push(`${monthlyColor}${monthly}%${RESET}`);
  }

  return parts.join('/');
}

/**
 * Render rate limits with visual progress bars.
 *
 * Format: 5h:[████░░░░░░]45%(3h42m) wk:[█░░░░░░░░░]12%(2d5h) mo:[░░░░░░░░░░]8%(15d3h)
 */
export function renderRateLimitsWithBar(
  limits: RateLimits | null,
  barWidth: number = 8
): string | null {
  if (!limits) return null;

  const fiveHour = Math.min(100, Math.max(0, Math.round(limits.fiveHourPercent)));
  const fiveHourColor = getColor(fiveHour);
  const fiveHourFilled = Math.round((fiveHour / 100) * barWidth);
  const fiveHourEmpty = barWidth - fiveHourFilled;
  const fiveHourBar = `${fiveHourColor}${'█'.repeat(fiveHourFilled)}${DIM}${'░'.repeat(fiveHourEmpty)}${RESET}`;
  const fiveHourReset = formatResetTime(limits.fiveHourResetsAt);

  const fiveHourPart = fiveHourReset
    ? `5h:[${fiveHourBar}]${fiveHourColor}${fiveHour}%${RESET}${DIM}(${fiveHourReset})${RESET}`
    : `5h:[${fiveHourBar}]${fiveHourColor}${fiveHour}%${RESET}`;

  const parts = [fiveHourPart];

  if (limits.weeklyPercent != null) {
    const weekly = Math.min(100, Math.max(0, Math.round(limits.weeklyPercent)));
    const weeklyColor = getColor(weekly);
    const weeklyFilled = Math.round((weekly / 100) * barWidth);
    const weeklyEmpty = barWidth - weeklyFilled;
    const weeklyBar = `${weeklyColor}${'█'.repeat(weeklyFilled)}${DIM}${'░'.repeat(weeklyEmpty)}${RESET}`;
    const weeklyReset = formatResetTime(limits.weeklyResetsAt);

    const weeklyPart = weeklyReset
      ? `${DIM}wk:${RESET}[${weeklyBar}]${weeklyColor}${weekly}%${RESET}${DIM}(${weeklyReset})${RESET}`
      : `${DIM}wk:${RESET}[${weeklyBar}]${weeklyColor}${weekly}%${RESET}`;

    parts.push(weeklyPart);
  }

  if (limits.monthlyPercent != null) {
    const monthly = Math.min(100, Math.max(0, Math.round(limits.monthlyPercent)));
    const monthlyColor = getColor(monthly);
    const monthlyFilled = Math.round((monthly / 100) * barWidth);
    const monthlyEmpty = barWidth - monthlyFilled;
    const monthlyBar = `${monthlyColor}${'█'.repeat(monthlyFilled)}${DIM}${'░'.repeat(monthlyEmpty)}${RESET}`;
    const monthlyReset = formatResetTime(limits.monthlyResetsAt);

    const monthlyPart = monthlyReset
      ? `${DIM}mo:${RESET}[${monthlyBar}]${monthlyColor}${monthly}%${RESET}${DIM}(${monthlyReset})${RESET}`
      : `${DIM}mo:${RESET}[${monthlyBar}]${monthlyColor}${monthly}%${RESET}`;

    parts.push(monthlyPart);
  }

  return parts.join(' ');
}

// ============================================================================
// Custom provider bucket rendering
// ============================================================================

/**
 * Compute a 0-100 usage percentage for threshold checks.
 * Returns null for string usage (no numeric basis).
 */
function bucketUsagePercent(usage: CustomBucketUsage): number | null {
  if (usage.type === 'percent') return usage.value;
  if (usage.type === 'credit' && usage.limit > 0) return (usage.used / usage.limit) * 100;
  return null;
}

/**
 * Render a bucket usage value as a display string.
 *   percent  → "32%"
 *   credit   → "250/300"
 *   string   → value as-is
 */
function renderBucketUsageValue(usage: CustomBucketUsage): string {
  if (usage.type === 'percent') return `${Math.round(usage.value)}%`;
  if (usage.type === 'credit') return `${usage.used}/${usage.limit}`;
  return usage.value;
}

/**
 * Render custom rate limit buckets from the rateLimitsProvider command.
 *
 * Format (normal):  label:32%  label2:250/300  label3:as-is
 * Format (stale):   label:32%*  (asterisk marks stale/cached data)
 * Format (error):   [cmd:err]
 *
 * resetsAt is shown only when usage exceeds thresholdPercent (default 85).
 */
export function renderCustomBuckets(
  result: CustomProviderResult,
  thresholdPercent: number = 85,
): string | null {
  // Command failed and no cached data
  if (result.error && result.buckets.length === 0) {
    return `${YELLOW}[cmd:err]${RESET}`;
  }

  if (result.buckets.length === 0) return null;

  const staleMarker = result.stale ? `${DIM}*${RESET}` : '';

  const parts = result.buckets.map((bucket) => {
    const pct = bucketUsagePercent(bucket.usage);
    const color = pct != null ? getColor(pct) : '';
    const colorReset = pct != null ? RESET : '';
    const usageStr = renderBucketUsageValue(bucket.usage);

    // Show resetsAt only above threshold (string usage never shows it)
    let resetPart = '';
    if (bucket.resetsAt && pct != null && pct >= thresholdPercent) {
      const d = new Date(bucket.resetsAt);
      if (!isNaN(d.getTime())) {
        const str = formatResetTime(d);
        if (str) resetPart = `${DIM}(${str})${RESET}`;
      }
    }

    return `${DIM}${bucket.label}:${RESET}${color}${usageStr}${colorReset}${staleMarker}${resetPart}`;
  });

  return parts.join(' ');
}
