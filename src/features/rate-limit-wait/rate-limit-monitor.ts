/**
 * Rate Limit Monitor
 *
 * Wraps the existing usage-api.ts to provide rate limit status monitoring.
 * Uses the OAuth API to check utilization percentages.
 */

import { getUsage } from '../../hud/usage-api.js';
import type { RateLimitStatus } from './types.js';

/** Threshold percentage for considering rate limited */
const RATE_LIMIT_THRESHOLD = 100;

/**
 * Check current rate limit status using the OAuth API
 *
 * @returns Rate limit status or null if API unavailable
 */
export async function checkRateLimitStatus(): Promise<RateLimitStatus | null> {
  try {
    const usage = await getUsage();

    if (!usage) {
      // No OAuth credentials or API unavailable
      return null;
    }

    const fiveHourLimited = (usage.fiveHourPercent ?? 0) >= RATE_LIMIT_THRESHOLD;
    const weeklyLimited = (usage.weeklyPercent ?? 0) >= RATE_LIMIT_THRESHOLD;
    const monthlyLimited = (usage.monthlyPercent ?? 0) >= RATE_LIMIT_THRESHOLD;
    const isLimited = fiveHourLimited || weeklyLimited || monthlyLimited;

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

  return message;
}
