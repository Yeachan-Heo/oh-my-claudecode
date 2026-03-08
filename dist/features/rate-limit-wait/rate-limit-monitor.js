/**
 * Rate Limit Monitor
 *
 * Wraps the existing usage-api.ts to provide rate limit status monitoring.
 * Uses the OAuth API to check utilization percentages.
 */
import { getUsage } from '../../hud/usage-api.js';
/** Threshold percentage for considering rate limited */
const RATE_LIMIT_THRESHOLD = 100;
/**
 * Check current rate limit status using the OAuth API
 *
 * @returns Rate limit status or null if API unavailable
 */
export async function checkRateLimitStatus() {
    try {
        const result = await getUsage();
        if (!result.rateLimits) {
            // No OAuth credentials or API unavailable
            return null;
        }
        const usage = result.rateLimits;
        const fiveHourLimited = (usage.fiveHourPercent ?? 0) >= RATE_LIMIT_THRESHOLD;
        const weeklyLimited = (usage.weeklyPercent ?? 0) >= RATE_LIMIT_THRESHOLD;
        const monthlyLimited = (usage.monthlyPercent ?? 0) >= RATE_LIMIT_THRESHOLD;
        const isLimited = fiveHourLimited || weeklyLimited || monthlyLimited;
        const usingStaleData = result.error === 'rate_limited' && !!result.rateLimits;
        // Determine next reset time
        let nextResetAt = null;
        let timeUntilResetMs = null;
        if (isLimited) {
            const now = Date.now();
            const resets = [];
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
                nextResetAt = resets.reduce((earliest, current) => current < earliest ? current : earliest);
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
    }
    catch (error) {
        // Log error but don't throw - return null to indicate unavailable
        console.error('[RateLimitMonitor] Error checking rate limit:', error);
        return null;
    }
}
/**
 * Format time until reset for display
 */
export function formatTimeUntilReset(ms) {
    if (ms <= 0)
        return 'now';
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) {
        const remainingMinutes = minutes % 60;
        return `${hours}h ${remainingMinutes}m`;
    }
    else if (minutes > 0) {
        const remainingSeconds = seconds % 60;
        return `${minutes}m ${remainingSeconds}s`;
    }
    return `${seconds}s`;
}
/**
 * Get a human-readable rate limit status message
 */
export function formatRateLimitStatus(status) {
    if (status.apiErrorReason === 'rate_limited' && !status.isLimited) {
        const cachedUsageParts = [];
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
            return `Usage API rate limited; showing stale cached usage (${cachedUsageParts.join(', ')})`;
        }
        return 'Usage API rate limited; current limit status unavailable';
    }
    if (!status.isLimited) {
        return 'Not rate limited';
    }
    const parts = [];
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
    }
    return message;
}
/**
 * Whether the underlying usage API is currently degraded by 429/stale-cache behavior.
 */
export function isRateLimitStatusDegraded(status) {
    return status?.apiErrorReason === 'rate_limited';
}
/**
 * Whether the daemon should keep monitoring blocked panes.
 * This includes both confirmed limit hits and degraded 429/stale-cache states.
 */
export function shouldMonitorBlockedPanes(status) {
    return !!status && (status.isLimited || isRateLimitStatusDegraded(status));
}
//# sourceMappingURL=rate-limit-monitor.js.map