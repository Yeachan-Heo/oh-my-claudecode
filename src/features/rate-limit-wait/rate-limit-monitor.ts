/**
 * Rate Limit Monitor
 *
 * Wraps the existing usage-api.ts to provide rate limit status monitoring.
 * Uses the OAuth API to check utilization percentages.
 */

import { getUsage } from '../../hud/usage-api.js';
import { readStdinCache } from '../../hud/stdin.js';
import type { RateLimitStatus } from './types.js';

/** Threshold percentage for considering rate limited */
const RATE_LIMIT_THRESHOLD = 100;

/**
 * Last Claude Code version OMC observed on the statusline, from its own stdin
 * cache. An observed value, not a guess; undefined when the cache is missing or
 * unreadable, and the usage request then sends no User-Agent.
 */
function readCachedClientVersion(): string | undefined {
  try {
    return readStdinCache()?.version;
  } catch {
    return undefined;
  }
}

/**
 * Check current rate limit status using the OAuth API
 *
 * @returns Rate limit status or null if API unavailable
 */
export async function checkRateLimitStatus(): Promise<RateLimitStatus | null> {
  try {
    // This monitor has no statusline payload of its own, but the usage endpoint
    // throttles requests whose User-Agent does not name a Claude Code version
    // (see buildUserAgent in usage-api.ts). Reuse the version the HUD last
    // observed on stdin and cached; undefined when OMC has never seen one.
    const result = await getUsage({
      clientVersion: readCachedClientVersion(),
      skipWarmCache: true,
    });

    if (!result.rateLimits) {
      // No OAuth credentials or API unavailable
      return null;
    }

    const usage = result.rateLimits;
    const fiveHourLimited = (usage.fiveHourPercent ?? 0) >= RATE_LIMIT_THRESHOLD;
    const weeklyLimited = (usage.weeklyPercent ?? 0) >= RATE_LIMIT_THRESHOLD;
    const monthlyLimited = (usage.monthlyPercent ?? 0) >= RATE_LIMIT_THRESHOLD;
    const isLimited = fiveHourLimited || weeklyLimited || monthlyLimited;
    const usingStaleData = result.stale === true;

    // Determine next reset time
    let nextResetAt: Date | null = null;
    let timeUntilResetMs: number | null = null;

    if (isLimited) {
      const now = Date.now();
      const resets: Date[] = [];

      if (fiveHourLimited && usage.fiveHourResetsAt) {
        resets.push(usage.fiveHourResetsAt);
      }
      if (weeklyLimited && usage.weeklyResetsAt) {
        resets.push(usage.weeklyResetsAt);
      }
      if (monthlyLimited && usage.monthlyResetsAt) {
        resets.push(usage.monthlyResetsAt);
      }

      if (resets.length > 0) {
        // Find earliest reset
        nextResetAt = resets.reduce((earliest, current) =>
          current < earliest ? current : earliest
        );
        timeUntilResetMs = Math.max(0, nextResetAt.getTime() - now);
      }
    }

    return {
      fiveHourLimited,
      weeklyLimited,
      monthlyLimited,
      isLimited,
      fiveHourResetsAt: usage.fiveHourResetsAt ?? null,
      weeklyResetsAt: usage.weeklyResetsAt ?? null,
      monthlyResetsAt: usage.monthlyResetsAt ?? null,
      nextResetAt,
      timeUntilResetMs,
      fiveHourPercent: usage.fiveHourPercent,
      weeklyPercent: usage.weeklyPercent,
      monthlyPercent: usage.monthlyPercent,
      apiErrorReason: result.error,
      usingStaleData,
      lastCheckedAt: new Date(),
    };
  } catch (error) {
    // Log error but don't throw - return null to indicate unavailable
    console.error('[RateLimitMonitor] Error checking rate limit:', error);
    return null;
  }
}

/**
 * Format time until reset for display
 */
export function formatTimeUntilReset(ms: number): string {
  if (ms <= 0) return 'now';

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  } else if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${seconds}s`;
}

/**
 * Get a human-readable rate limit status message
 */
export function formatRateLimitStatus(status: RateLimitStatus): string {
  if (isRateLimitStatusDegraded(status) && !status.isLimited) {
    const cachedUsageParts: string[] = [];
    const errorMessage = status.apiErrorReason === 'rate_limited'
      ? 'Usage API rate limited'
      : status.apiErrorReason
        ? `Usage API ${status.apiErrorReason} error`
        : 'Usage data stale';

    if (typeof status.fiveHourPercent === 'number') {
      cachedUsageParts.push(`5-hour ${status.fiveHourPercent}%`);
    }
    if (typeof status.weeklyPercent === 'number') {
      cachedUsageParts.push(`weekly ${status.weeklyPercent}%`);
    }
    if (typeof status.monthlyPercent === 'number') {
      cachedUsageParts.push(`monthly ${status.monthlyPercent}%`);
    }

    if (cachedUsageParts.length > 0) {
      return `${errorMessage}; showing stale cached usage (${cachedUsageParts.join(', ')})`;
    }
    return `${errorMessage}; current limit status unavailable`;
  }

  if (!status.isLimited) {
    return 'Not rate limited';
  }

  const parts: string[] = [];

  if (status.fiveHourLimited) {
    parts.push('5-hour limit reached');
  }
  if (status.weeklyLimited) {
    parts.push('Weekly limit reached');
  }
  if (status.monthlyLimited) {
    parts.push('Monthly limit reached');
  }

  let message = parts.join(' and ');

  if (status.timeUntilResetMs !== null) {
    message += ` (resets in ${formatTimeUntilReset(status.timeUntilResetMs)})`;
  }

  if (status.apiErrorReason === 'rate_limited') {
    message += ' [usage API 429; cached data]';
  } else if (status.usingStaleData) {
    message += ` [${status.apiErrorReason ? `usage API ${status.apiErrorReason} error` : 'stale usage'}; cached data]`;
  }

  return message;
}

/**
 * Whether the latest usage sample is stale or otherwise cannot confirm recovery.
 */
export function isRateLimitStatusDegraded(status: RateLimitStatus | null): boolean {
  return !!status && (status.usingStaleData === true || status.apiErrorReason !== undefined);
}

/**
 * Whether the daemon should actively scan for blocked panes.
 * A stale limited value carries the last known exhausted state; only a fresh
 * all-clear can authorize resuming panes.
 */
export function shouldMonitorBlockedPanes(status: RateLimitStatus | null): boolean {
  return !!status?.isLimited;
}
