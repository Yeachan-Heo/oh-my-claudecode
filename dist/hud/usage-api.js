/**
 * OMC HUD - Usage API
 *
 * Fetches rate limit usage from Anthropic's OAuth API.
 * Based on claude-hud implementation by jarrodwatts.
 *
 * Authentication:
 * - macOS: Reads from Keychain "Claude Code-credentials"
 * - Linux/fallback: Reads from ~/.claude/.credentials.json
 *
 * API: api.anthropic.com/api/oauth/usage
 * Response: { five_hour: { utilization }, seven_day: { utilization } }
 */
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'fs';
import { getClaudeConfigDir } from '../utils/config-dir.js';
import { join, dirname } from 'path';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { userInfo } from 'os';
import https from 'https';
import { validateAnthropicBaseUrl } from '../utils/ssrf-guard.js';
import { DEFAULT_HUD_USAGE_POLL_INTERVAL_MS, } from './types.js';
import { readHudConfig } from './state.js';
import { lockPathFor, withFileLock } from '../lib/file-lock.js';
// Cache configuration
const CACHE_TTL_FAILURE_MS = 15 * 1000; // 15 seconds for non-transient failures
const CACHE_TTL_TRANSIENT_NETWORK_MS = 2 * 60 * 1000; // 2 minutes to avoid hammering transient API failures
const MAX_RATE_LIMITED_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes max for sustained 429s
const API_TIMEOUT_MS = 10000;
const MAX_STALE_DATA_MS = 15 * 60 * 1000; // 15 minutes — discard stale data after this
const TOKEN_REFRESH_URL_HOSTNAME = 'platform.claude.com';
const USAGE_CACHE_LOCK_OPTS = { staleLockMs: API_TIMEOUT_MS + 5000 };
const TOKEN_REFRESH_URL_PATH = '/v1/oauth/token';
/**
 * OAuth client_id for Claude Code (public client).
 * This is the production value; can be overridden via CLAUDE_CODE_OAUTH_CLIENT_ID env var.
 */
const DEFAULT_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
function isEnterpriseUsageContext(options) {
    if (!options)
        return true;
    const subscriptionType = options.subscriptionType?.toLowerCase() ?? null;
    const rateLimitTier = options.rateLimitTier ?? null;
    if (subscriptionType == null && rateLimitTier == null)
        return true;
    return subscriptionType === 'enterprise' || /claude_zero/i.test(rateLimitTier ?? '');
}
// z.ai `unit` code for the weekly TOKENS_LIMIT bucket (observed, undocumented)
const ZAI_UNIT_WEEK = 6;
/**
 * Check if a URL points to z.ai (exact hostname match)
 */
export function isZaiHost(urlString) {
    try {
        const url = new URL(urlString);
        const hostname = url.hostname.toLowerCase();
        return hostname === 'z.ai' || hostname.endsWith('.z.ai');
    }
    catch {
        return false;
    }
}
/**
 * Check if a URL points to MiniMax.
 * Matches all known MiniMax domains:
 *   - minimax.io / *.minimax.io  (international)
 *   - minimaxi.com / *.minimaxi.com  (China)
 *   - minimax.com / *.minimax.com  (China alternative)
 */
export function isMinimaxHost(urlString) {
    try {
        const url = new URL(urlString);
        const hostname = url.hostname.toLowerCase();
        return (hostname === 'minimax.io' || hostname.endsWith('.minimax.io') ||
            hostname === 'minimaxi.com' || hostname.endsWith('.minimaxi.com') ||
            hostname === 'minimax.com' || hostname.endsWith('.minimax.com'));
    }
    catch {
        return false;
    }
}
/**
 * Get the legacy (pre-split) cache file path
 */
function getLegacyCachePath() {
    return join(getClaudeConfigDir(), 'plugins', 'oh-my-claudecode', '.usage-cache.json');
}
/**
 * Get the provider-specific cache file path
 */
function getCachePath(source) {
    return join(getClaudeConfigDir(), 'plugins', 'oh-my-claudecode', `.usage-cache-${source}.json`);
}
/**
 * Migrate legacy single-file cache to provider-specific file.
 * One-shot: only runs when the provider-specific file does not yet exist
 * and the legacy cache's source matches the current provider.
 * Does NOT delete the legacy file (rolling update safety).
 */
function migrateLegacyCache(source) {
    try {
        const legacyPath = getLegacyCachePath();
        if (!existsSync(legacyPath))
            return;
        // One-shot guard: skip if new file already exists
        if (existsSync(getCachePath(source)))
            return;
        const content = readFileSync(legacyPath, 'utf-8');
        const cache = JSON.parse(content);
        // Source mismatch guard: only migrate if legacy cache belongs to this provider
        if (cache.source !== source)
            return;
        const newPath = getCachePath(source);
        const cacheDir = dirname(newPath);
        if (!existsSync(cacheDir)) {
            mkdirSync(cacheDir, { recursive: true });
        }
        writeFileSync(newPath, content);
    }
    catch {
        // Best-effort migration — failures are harmless
    }
}
/**
 * Read cached usage data for a specific provider
 */
function readCache(source) {
    try {
        const cachePath = getCachePath(source);
        if (!existsSync(cachePath))
            return null;
        const content = readFileSync(cachePath, 'utf-8');
        const cache = JSON.parse(content);
        // Re-hydrate Date objects from JSON strings
        if (cache.data) {
            if (cache.data.fiveHourResetsAt) {
                cache.data.fiveHourResetsAt = new Date(cache.data.fiveHourResetsAt);
            }
            if (cache.data.weeklyResetsAt) {
                cache.data.weeklyResetsAt = new Date(cache.data.weeklyResetsAt);
            }
            if (cache.data.sonnetWeeklyResetsAt) {
                cache.data.sonnetWeeklyResetsAt = new Date(cache.data.sonnetWeeklyResetsAt);
            }
            if (cache.data.opusWeeklyResetsAt) {
                cache.data.opusWeeklyResetsAt = new Date(cache.data.opusWeeklyResetsAt);
            }
            if (cache.data.monthlyResetsAt) {
                cache.data.monthlyResetsAt = new Date(cache.data.monthlyResetsAt);
            }
            if (cache.data.extraUsageResetsAt) {
                cache.data.extraUsageResetsAt = new Date(cache.data.extraUsageResetsAt);
            }
        }
        return cache;
    }
    catch {
        return null;
    }
}
/**
 * Write usage data to cache (provider-specific file)
 */
function writeCache(opts) {
    try {
        const cachePath = getCachePath(opts.source);
        const cacheDir = dirname(cachePath);
        if (!existsSync(cacheDir)) {
            mkdirSync(cacheDir, { recursive: true });
        }
        const cache = {
            timestamp: Date.now(),
            data: opts.data,
            error: opts.error,
            errorReason: opts.errorReason,
            source: opts.source,
            rateLimited: opts.rateLimited || undefined,
            rateLimitedCount: opts.rateLimitedCount && opts.rateLimitedCount > 0 ? opts.rateLimitedCount : undefined,
            rateLimitedUntil: opts.rateLimitedUntil,
            lastSuccessAt: opts.lastSuccessAt,
        };
        writeFileSync(cachePath, JSON.stringify(cache, null, 2));
    }
    catch {
        // Ignore cache write errors
    }
}
/**
 * Check if cache is still valid
 */
function sanitizePollIntervalMs(value) {
    if (value == null || !Number.isFinite(value) || value <= 0) {
        return DEFAULT_HUD_USAGE_POLL_INTERVAL_MS;
    }
    return Math.max(1000, Math.floor(value));
}
function getUsagePollIntervalMs() {
    try {
        return sanitizePollIntervalMs(readHudConfig().usageApiPollIntervalMs);
    }
    catch {
        return DEFAULT_HUD_USAGE_POLL_INTERVAL_MS;
    }
}
function getRateLimitedBackoffMs(pollIntervalMs, count) {
    const normalizedPollIntervalMs = sanitizePollIntervalMs(pollIntervalMs);
    return Math.min(normalizedPollIntervalMs * Math.pow(2, Math.max(0, count - 1)), MAX_RATE_LIMITED_BACKOFF_MS);
}
function getTransientNetworkBackoffMs(pollIntervalMs) {
    return Math.max(CACHE_TTL_TRANSIENT_NETWORK_MS, sanitizePollIntervalMs(pollIntervalMs));
}
function isCacheValid(cache, pollIntervalMs) {
    if (cache.rateLimited) {
        if (cache.rateLimitedUntil != null) {
            return Date.now() < cache.rateLimitedUntil;
        }
        const count = cache.rateLimitedCount || 1;
        return Date.now() - cache.timestamp < getRateLimitedBackoffMs(pollIntervalMs, count);
    }
    const ttl = cache.error
        ? cache.errorReason === 'network'
            ? getTransientNetworkBackoffMs(pollIntervalMs)
            : CACHE_TTL_FAILURE_MS
        : sanitizePollIntervalMs(pollIntervalMs);
    return Date.now() - cache.timestamp < ttl;
}
function hasUsableStaleData(cache) {
    if (!cache?.data) {
        return false;
    }
    if (cache.lastSuccessAt && Date.now() - cache.lastSuccessAt > MAX_STALE_DATA_MS) {
        return false;
    }
    return true;
}
function getCachedUsageResult(cache) {
    if (cache.rateLimited) {
        if (!hasUsableStaleData(cache) && cache.data) {
            return { rateLimits: null, error: 'rate_limited' };
        }
        return { rateLimits: cache.data, error: 'rate_limited', stale: cache.data ? true : undefined };
    }
    if (cache.error) {
        const errorReason = cache.errorReason || 'network';
        if (hasUsableStaleData(cache)) {
            return { rateLimits: cache.data, error: errorReason, stale: true };
        }
        return { rateLimits: null, error: errorReason };
    }
    return { rateLimits: cache.data };
}
function createRateLimitedCacheEntry(source, data, pollIntervalMs, previousCount, lastSuccessAt) {
    const timestamp = Date.now();
    const rateLimitedCount = previousCount + 1;
    return {
        timestamp,
        data,
        error: false,
        errorReason: 'rate_limited',
        source,
        rateLimited: true,
        rateLimitedCount,
        rateLimitedUntil: timestamp + getRateLimitedBackoffMs(pollIntervalMs, rateLimitedCount),
        lastSuccessAt,
    };
}
/**
 * Get the Keychain service name for the current config directory.
 * Claude Code uses "Claude Code-credentials-{sha256(configDir)[:8]}" for
 * non-default dirs, where configDir is derived from the exact
 * CLAUDE_CONFIG_DIR value rather than the expanded filesystem path. Preserve
 * that behavior so ~-prefixed profiles keep matching Claude Code's own
 * Keychain entries.
 */
function getKeychainServiceName() {
    const configDir = process.env.CLAUDE_CONFIG_DIR;
    if (configDir) {
        const hash = createHash('sha256').update(configDir).digest('hex').slice(0, 8);
        return `Claude Code-credentials-${hash}`;
    }
    return 'Claude Code-credentials';
}
function isCredentialExpired(creds) {
    return creds.expiresAt != null && creds.expiresAt <= Date.now();
}
function readKeychainCredential(serviceName, account) {
    try {
        const args = account
            ? ['find-generic-password', '-s', serviceName, '-a', account, '-w']
            : ['find-generic-password', '-s', serviceName, '-w'];
        const result = execFileSync('/usr/bin/security', args, {
            encoding: 'utf-8',
            timeout: 2000,
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        if (!result)
            return null;
        const parsed = JSON.parse(result);
        // Handle nested structure (claudeAiOauth wrapper)
        const creds = parsed.claudeAiOauth || parsed;
        if (!creds.accessToken)
            return null;
        return {
            accessToken: creds.accessToken,
            expiresAt: creds.expiresAt,
            refreshToken: creds.refreshToken,
            source: 'keychain',
            subscriptionType: creds.subscriptionType,
            rateLimitTier: creds.rateLimitTier,
        };
    }
    catch {
        return null;
    }
}
/**
 * Read OAuth credentials from macOS Keychain
 */
function readKeychainCredentials() {
    if (process.platform !== 'darwin')
        return null;
    const serviceName = getKeychainServiceName();
    const candidateAccounts = [];
    try {
        const username = userInfo().username?.trim();
        if (username) {
            candidateAccounts.push(username);
        }
    }
    catch {
        // Best-effort only; fall back to the legacy service-only lookup below.
    }
    candidateAccounts.push(undefined);
    let expiredFallback = null;
    for (const account of candidateAccounts) {
        const creds = readKeychainCredential(serviceName, account);
        if (!creds)
            continue;
        if (!isCredentialExpired(creds)) {
            return creds;
        }
        expiredFallback ??= creds;
    }
    return expiredFallback;
}
/**
 * Read OAuth credentials from file fallback
 */
function readFileCredentials() {
    try {
        const credPath = join(getClaudeConfigDir(), '.credentials.json');
        if (!existsSync(credPath))
            return null;
        const content = readFileSync(credPath, 'utf-8');
        const parsed = JSON.parse(content);
        // Handle nested structure (claudeAiOauth wrapper)
        const creds = parsed.claudeAiOauth || parsed;
        if (creds.accessToken) {
            return {
                accessToken: creds.accessToken,
                expiresAt: creds.expiresAt,
                refreshToken: creds.refreshToken,
                source: 'file',
                subscriptionType: creds.subscriptionType,
                rateLimitTier: creds.rateLimitTier,
            };
        }
    }
    catch {
        // File read failed
    }
    return null;
}
/**
 * Get OAuth credentials (Keychain first, then file fallback)
 */
function getCredentials() {
    // Try Keychain first (macOS)
    const keychainCreds = readKeychainCredentials();
    if (keychainCreds)
        return keychainCreds;
    // Fall back to file
    return readFileCredentials();
}
/**
 * Get subscription info from OAuth credentials.
 * Returns subscriptionType and rateLimitTier (null when unavailable; never throws).
 */
export function getSubscriptionInfo() {
    try {
        const creds = getCredentials();
        return {
            subscriptionType: creds?.subscriptionType ?? null,
            rateLimitTier: creds?.rateLimitTier ?? null,
        };
    }
    catch {
        return { subscriptionType: null, rateLimitTier: null };
    }
}
/**
 * Validate credentials are not expired
 */
function validateCredentials(creds) {
    if (!creds.accessToken)
        return false;
    return !isCredentialExpired(creds);
}
/**
 * Attempt to refresh an expired OAuth access token using the refresh token.
 * Returns updated credentials on success, null on failure.
 */
function refreshAccessToken(refreshToken) {
    return new Promise((resolve) => {
        const clientId = process.env.CLAUDE_CODE_OAUTH_CLIENT_ID || DEFAULT_OAUTH_CLIENT_ID;
        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: clientId,
        }).toString();
        const req = https.request({
            hostname: TOKEN_REFRESH_URL_HOSTNAME,
            path: TOKEN_REFRESH_URL_PATH,
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
            },
            timeout: API_TIMEOUT_MS,
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.access_token) {
                            resolve({
                                accessToken: parsed.access_token,
                                refreshToken: parsed.refresh_token || refreshToken,
                                expiresAt: parsed.expires_in
                                    ? Date.now() + parsed.expires_in * 1000
                                    : parsed.expires_at,
                            });
                            return;
                        }
                    }
                    catch {
                        // JSON parse failed
                    }
                }
                if (process.env.OMC_DEBUG) {
                    console.error(`[usage-api] Token refresh failed: HTTP ${res.statusCode}`);
                }
                resolve(null);
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.end(body);
    });
}
/**
 * Fetch usage from Anthropic API
 */
function fetchUsageFromApi(accessToken) {
    return new Promise((resolve) => {
        const req = https.request({
            hostname: 'api.anthropic.com',
            path: '/api/oauth/usage',
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'anthropic-beta': 'oauth-2025-04-20',
                'Content-Type': 'application/json',
            },
            timeout: API_TIMEOUT_MS,
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        resolve({ data: JSON.parse(data) });
                    }
                    catch {
                        resolve({ data: null });
                    }
                }
                else if (res.statusCode === 429) {
                    if (process.env.OMC_DEBUG) {
                        console.error(`[usage-api] Anthropic API returned 429 (rate limited)`);
                    }
                    resolve({ data: null, rateLimited: true });
                }
                else {
                    resolve({ data: null });
                }
            });
        });
        req.on('error', () => resolve({ data: null }));
        req.on('timeout', () => {
            req.destroy();
            resolve({ data: null });
        });
        req.end();
    });
}
/**
 * Fetch usage from z.ai GLM API
 */
function fetchUsageFromZai() {
    return new Promise((resolve) => {
        const baseUrl = process.env.ANTHROPIC_BASE_URL;
        const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
        if (!baseUrl || !authToken) {
            resolve({ data: null });
            return;
        }
        // Validate baseUrl for SSRF protection
        const validation = validateAnthropicBaseUrl(baseUrl);
        if (!validation.allowed) {
            console.error(`[SSRF Guard] Blocking usage API call: ${validation.reason}`);
            resolve({ data: null });
            return;
        }
        try {
            const url = new URL(baseUrl);
            const baseDomain = `${url.protocol}//${url.host}`;
            const quotaLimitUrl = `${baseDomain}/api/monitor/usage/quota/limit`;
            const urlObj = new URL(quotaLimitUrl);
            const req = https.request({
                hostname: urlObj.hostname,
                path: urlObj.pathname,
                method: 'GET',
                headers: {
                    'Authorization': authToken,
                    'Content-Type': 'application/json',
                    'Accept-Language': 'en-US,en',
                },
                timeout: API_TIMEOUT_MS,
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        try {
                            resolve({ data: JSON.parse(data) });
                        }
                        catch {
                            resolve({ data: null });
                        }
                    }
                    else if (res.statusCode === 429) {
                        if (process.env.OMC_DEBUG) {
                            console.error(`[usage-api] z.ai API returned 429 (rate limited)`);
                        }
                        resolve({ data: null, rateLimited: true });
                    }
                    else {
                        resolve({ data: null });
                    }
                });
            });
            req.on('error', () => resolve({ data: null }));
            req.on('timeout', () => { req.destroy(); resolve({ data: null }); });
            req.end();
        }
        catch {
            resolve({ data: null });
        }
    });
}
/**
 * Persist refreshed credentials back to the file-based credential store.
 * Keychain write-back is not supported (read-only for HUD).
 * Updates only the claudeAiOauth fields, preserving other data.
 */
function writeBackCredentials(creds) {
    try {
        const credPath = join(getClaudeConfigDir(), '.credentials.json');
        if (!existsSync(credPath))
            return;
        const content = readFileSync(credPath, 'utf-8');
        const parsed = JSON.parse(content);
        // Update the nested structure
        if (parsed.claudeAiOauth) {
            parsed.claudeAiOauth.accessToken = creds.accessToken;
            if (creds.expiresAt != null) {
                parsed.claudeAiOauth.expiresAt = creds.expiresAt;
            }
            if (creds.refreshToken) {
                parsed.claudeAiOauth.refreshToken = creds.refreshToken;
            }
        }
        else {
            // Flat structure
            parsed.accessToken = creds.accessToken;
            if (creds.expiresAt != null) {
                parsed.expiresAt = creds.expiresAt;
            }
            if (creds.refreshToken) {
                parsed.refreshToken = creds.refreshToken;
            }
        }
        // Atomic write: write to tmp file, then rename (atomic on POSIX, best-effort on Windows)
        const tmpPath = `${credPath}.tmp.${process.pid}`;
        try {
            writeFileSync(tmpPath, JSON.stringify(parsed, null, 2), { mode: 0o600 });
            renameSync(tmpPath, credPath);
        }
        catch (writeErr) {
            // Clean up orphaned tmp file on failure
            try {
                if (existsSync(tmpPath)) {
                    unlinkSync(tmpPath);
                }
            }
            catch {
                // Ignore cleanup errors
            }
            throw writeErr;
        }
    }
    catch {
        // Silent failure - credential write-back is best-effort
        if (process.env.OMC_DEBUG) {
            console.error('[usage-api] Failed to write back refreshed credentials');
        }
    }
}
/**
 * Clamp values to 0-100 and filter invalid
 */
function clamp(v) {
    if (v == null || !isFinite(v))
        return 0;
    return Math.max(0, Math.min(100, v));
}
/**
 * Parse API response into RateLimits
 */
export function parseUsageResponse(response, options) {
    const fiveHour = response.five_hour?.utilization;
    const sevenDay = response.seven_day?.utilization;
    const sonnetSevenDay = response.seven_day_sonnet?.utilization;
    const opusSevenDay = response.seven_day_opus?.utilization;
    const extra = response.extra_usage;
    const usedCredits = extra?.used_credits;
    const extraCurrency = (extra?.currency ?? 'USD').toUpperCase();
    const isEnterpriseContext = isEnterpriseUsageContext(options);
    // used_credits are only usable when we know how to interpret the minor-unit digits;
    // see the USD guards in the extra_usage branch below for rationale.
    const hasUsableUsedCredits = usedCredits != null && extraCurrency === 'USD';
    const hasUsableEnterprise = isEnterpriseContext && hasUsableUsedCredits;
    const hasUsableUsdExtraUsage = extra?.limit_usd != null && extra.limit_usd > 0;
    const hasUsableCreditExtraUsage = !isEnterpriseContext && hasUsableUsedCredits && extra?.monthly_limit != null && extra.monthly_limit > 0;
    const hasUsableExtraUsage = hasUsableUsdExtraUsage || hasUsableCreditExtraUsage;
    // Need at least one valid value. Model-specific weekly buckets are valid usage data
    // even when generic subscription/window metadata is absent or nullish.
    if (fiveHour == null &&
        sevenDay == null &&
        sonnetSevenDay == null &&
        opusSevenDay == null &&
        !hasUsableEnterprise &&
        !hasUsableExtraUsage)
        return null;
    // Parse ISO 8601 date strings to Date objects
    const parseDate = (dateStr) => {
        if (!dateStr)
            return null;
        try {
            const date = new Date(dateStr);
            return isNaN(date.getTime()) ? null : date;
        }
        catch {
            return null;
        }
    };
    // Per-model quotas are at the top level (flat structure)
    // e.g., response.seven_day_sonnet, response.seven_day_opus
    const sonnetResetsAt = response.seven_day_sonnet?.resets_at;
    const result = {
        fiveHourPercent: clamp(fiveHour),
        fiveHourResetsAt: parseDate(response.five_hour?.resets_at),
    };
    if (sevenDay != null) {
        result.weeklyPercent = clamp(sevenDay);
        result.weeklyResetsAt = parseDate(response.seven_day?.resets_at);
    }
    // Add Sonnet-specific quota if available from API
    if (sonnetSevenDay != null) {
        result.sonnetWeeklyPercent = clamp(sonnetSevenDay);
        result.sonnetWeeklyResetsAt = parseDate(sonnetResetsAt);
    }
    // Add Opus-specific quota if available from API
    const opusResetsAt = response.seven_day_opus?.resets_at;
    if (opusSevenDay != null) {
        result.opusWeeklyPercent = clamp(opusSevenDay);
        result.opusWeeklyResetsAt = parseDate(opusResetsAt);
    }
    // Add extra (metered) usage if available (Pro subscribers with extra usage allocation)
    if (extra != null) {
        // Enterprise path: used_credits (minor units) is present instead of spent_usd/limit_usd.
        // Only USD is observed in practice; the /100 divisor below assumes 2-digit minor units.
        // For any non-USD currency we refuse to guess the minor-unit digit count (JPY/KRW are
        // 0-digit, TND/BHD are 3-digit per ISO 4217) and skip the enterprise fields — the
        // renderer will then return null rather than display a wrong figure.
        const currency = (extra.currency ?? 'USD').toUpperCase();
        if (extra.used_credits != null && currency === 'USD' && isEnterpriseContext) {
            result.enterpriseSpentUsd = extra.used_credits / 100;
            result.enterpriseLimitUsd = extra.monthly_limit == null ? null : extra.monthly_limit / 100;
            result.enterpriseCurrency = currency;
            // Only compute utilization when there is a positive cap
            if (extra.monthly_limit != null && extra.monthly_limit > 0) {
                result.enterpriseUtilization = clamp((extra.used_credits / extra.monthly_limit) * 100);
            }
            // resets_at not provided in enterprise response — leave enterpriseResetsAt unset
        }
        else if (extra.used_credits != null && currency === 'USD' && !isEnterpriseContext && extra.monthly_limit != null && extra.monthly_limit > 0) {
            // Max/Pro organization overage path: the API can use the enterprise-shaped
            // used_credits/monthly_limit fields even though the account should still render
            // normal token-window limits. Treat those minor-unit values as extra usage.
            const spentUsd = extra.used_credits / 100;
            result.extraUsageSpentUsd = spentUsd;
            result.extraUsageLimitUsd = extra.monthly_limit / 100;
            result.extraUsagePercent = extra.utilization != null
                ? clamp(extra.utilization)
                : clamp((extra.used_credits / extra.monthly_limit) * 100);
            result.extraUsageResetsAt = parseDate(extra.resets_at);
        }
        else if (extra.limit_usd != null && extra.limit_usd > 0) {
            // Pro metered path
            const spentUsd = extra.spent_usd ?? 0;
            result.extraUsageSpentUsd = spentUsd;
            result.extraUsageLimitUsd = extra.limit_usd;
            // Use API-provided utilization when available; fall back to spent/limit ratio
            result.extraUsagePercent = extra.utilization != null
                ? clamp(extra.utilization)
                : clamp((spentUsd / extra.limit_usd) * 100);
            result.extraUsageResetsAt = parseDate(extra.resets_at);
        }
    }
    return result;
}
/**
 * Parse z.ai API response into RateLimits.
 *
 * Weekly TOKENS_LIMIT exists only for plans purchased on/after 2026-02-12
 * (UTC+8); older accounts return only the 5-hour bucket regardless of tier.
 * Classify by the entry's `unit` field (not nextResetTime) so buckets don't
 * swap near a weekly reset boundary; fall back to nextResetTime ordering
 * when `unit` is absent.
 */
export function parseZaiResponse(response) {
    const limits = response.data?.limits;
    if (!limits || limits.length === 0)
        return null;
    const allTokensLimits = limits.filter(l => l.type === 'TOKENS_LIMIT');
    const timeLimit = limits.find(l => l.type === 'TIME_LIMIT');
    if (allTokensLimits.length === 0 && !timeLimit)
        return null;
    // Parse nextResetTime (Unix timestamp in milliseconds) to Date
    const parseResetTime = (timestamp) => {
        if (!timestamp)
            return null;
        try {
            const date = new Date(timestamp);
            return isNaN(date.getTime()) ? null : date;
        }
        catch {
            return null;
        }
    };
    // Earlier reset wins 5h slot; equal reset, smaller percentage wins
    const sortByResetTime = (a, b) => {
        const aTime = a.nextResetTime && a.nextResetTime > 0 ? a.nextResetTime : Infinity;
        const bTime = b.nextResetTime && b.nextResetTime > 0 ? b.nextResetTime : Infinity;
        if (aTime !== bTime)
            return aTime - bTime;
        return (a.percentage ?? 0) - (b.percentage ?? 0);
    };
    const weeklyByUnit = allTokensLimits.find(l => l.unit === ZAI_UNIT_WEEK);
    let fiveHourBucket;
    let weeklyBucket;
    if (weeklyByUnit) {
        weeklyBucket = weeklyByUnit;
        fiveHourBucket = allTokensLimits
            .filter(l => l.unit !== ZAI_UNIT_WEEK)
            .slice()
            .sort(sortByResetTime)[0];
    }
    else {
        // Legacy fallback: no unit field → sort all TOKENS_LIMIT by nextResetTime
        const sorted = allTokensLimits.slice().sort(sortByResetTime);
        fiveHourBucket = sorted[0];
        weeklyBucket = sorted[1];
    }
    if (allTokensLimits.length > 2 && process.env.OMC_DEBUG) {
        console.error(`[usage-api] z.ai returned ${allTokensLimits.length} TOKENS_LIMIT entries; using unit-based classification`);
    }
    const result = {
        fiveHourPercent: clamp(fiveHourBucket?.percentage),
        fiveHourResetsAt: parseResetTime(fiveHourBucket?.nextResetTime),
        monthlyPercent: timeLimit ? clamp(timeLimit.percentage) : undefined,
        monthlyResetsAt: timeLimit ? (parseResetTime(timeLimit.nextResetTime) ?? null) : undefined,
    };
    if (weeklyBucket) {
        result.weeklyPercent = clamp(weeklyBucket.percentage);
        result.weeklyResetsAt = parseResetTime(weeklyBucket.nextResetTime);
    }
    return result;
}
/**
 * Fetch usage from MiniMax coding plan API
 */
function fetchUsageFromMinimax(apiKey) {
    return new Promise((resolve) => {
        const baseUrl = process.env.ANTHROPIC_BASE_URL;
        if (!baseUrl) {
            resolve({ data: null });
            return;
        }
        // Validate baseUrl for SSRF protection
        const validation = validateAnthropicBaseUrl(baseUrl);
        if (!validation.allowed) {
            console.error(`[SSRF Guard] Blocking usage API call: ${validation.reason}`);
            resolve({ data: null });
            return;
        }
        try {
            const url = new URL(baseUrl);
            const baseDomain = `${url.protocol}//${url.host}`;
            const quotaUrl = `${baseDomain}/v1/api/openplatform/coding_plan/remains`;
            const urlObj = new URL(quotaUrl);
            const req = https.request({
                hostname: urlObj.hostname,
                path: urlObj.pathname,
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                timeout: API_TIMEOUT_MS,
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        try {
                            resolve({ data: JSON.parse(data) });
                        }
                        catch {
                            resolve({ data: null });
                        }
                    }
                    else if (res.statusCode === 429) {
                        if (process.env.OMC_DEBUG) {
                            console.error(`[usage-api] MiniMax API returned 429 (rate limited)`);
                        }
                        resolve({ data: null, rateLimited: true });
                    }
                    else {
                        resolve({ data: null });
                    }
                });
            });
            req.on('error', () => resolve({ data: null }));
            req.on('timeout', () => { req.destroy(); resolve({ data: null }); });
            req.end();
        }
        catch {
            resolve({ data: null });
        }
    });
}
/**
 * Parse MiniMax coding plan API response into RateLimits
 */
export function parseMinimaxResponse(response) {
    // Check for API error status
    if (response.base_resp?.status_code != null && response.base_resp.status_code !== 0) {
        return null;
    }
    const models = response.model_remains;
    if (!models || models.length === 0)
        return null;
    // Find the primary coding model (first match, case-insensitive)
    const codingModel = models.find(m => m.model_name.toLowerCase().startsWith('minimax-m'));
    if (!codingModel) {
        if (process.env.OMC_DEBUG) {
            console.error('[usage-api] No MiniMax-M* model found in coding plan response');
        }
        return null;
    }
    // MiniMax's "remains" endpoint reports remaining quota, not consumed quota.
    // Convert remaining-count fields to used percentages for the HUD.
    const intervalTotal = codingModel.current_interval_total_count;
    const intervalUsed = intervalTotal - codingModel.current_interval_usage_count;
    const intervalPercent = intervalTotal > 0 ? (intervalUsed / intervalTotal) * 100 : 0;
    // Calculate weekly usage percentage from remaining weekly quota
    const weeklyTotal = codingModel.current_weekly_total_count;
    const weeklyUsed = weeklyTotal - codingModel.current_weekly_usage_count;
    const weeklyPercent = weeklyTotal > 0 ? (weeklyUsed / weeklyTotal) * 100 : 0;
    // Parse reset times from Unix ms timestamps
    const parseResetTime = (timestamp) => {
        if (!timestamp)
            return null;
        try {
            const date = new Date(timestamp);
            return isNaN(date.getTime()) ? null : date;
        }
        catch {
            return null;
        }
    };
    return {
        fiveHourPercent: clamp(intervalPercent),
        fiveHourResetsAt: parseResetTime(codingModel.end_time),
        weeklyPercent: clamp(weeklyPercent),
        weeklyResetsAt: parseResetTime(codingModel.weekly_end_time),
    };
}
/**
 * Generic provider fetch-and-cache cycle.
 * Handles 429 backoff, stale data fallback, and cache writes.
 * Provider-specific pre-fetch logic (e.g., credential refresh) runs before calling this.
 */
async function fetchAndCacheUsage(opts) {
    const { source, fetchFn, parseFn, cache, pollIntervalMs } = opts;
    const result = await fetchFn();
    if (result.rateLimited) {
        const prevLastSuccess = cache?.lastSuccessAt;
        const rateLimitedCache = createRateLimitedCacheEntry(source, cache?.data || null, pollIntervalMs, cache?.rateLimitedCount || 0, prevLastSuccess);
        writeCache({
            data: rateLimitedCache.data,
            error: rateLimitedCache.error,
            source,
            rateLimited: true,
            rateLimitedCount: rateLimitedCache.rateLimitedCount,
            rateLimitedUntil: rateLimitedCache.rateLimitedUntil,
            errorReason: 'rate_limited',
            lastSuccessAt: rateLimitedCache.lastSuccessAt,
        });
        if (rateLimitedCache.data) {
            if (prevLastSuccess && Date.now() - prevLastSuccess > MAX_STALE_DATA_MS) {
                return { rateLimits: null, error: 'rate_limited' };
            }
            return { rateLimits: rateLimitedCache.data, error: 'rate_limited', stale: true };
        }
        return { rateLimits: null, error: 'rate_limited' };
    }
    if (!result.data) {
        const fallbackData = hasUsableStaleData(cache) ? cache.data : null;
        writeCache({
            data: fallbackData,
            error: true,
            source,
            errorReason: 'network',
            lastSuccessAt: cache?.lastSuccessAt,
        });
        if (fallbackData) {
            return { rateLimits: fallbackData, error: 'network', stale: true };
        }
        return { rateLimits: null, error: 'network' };
    }
    const usage = parseFn(result.data);
    writeCache({ data: usage, error: !usage, source, lastSuccessAt: Date.now() });
    return { rateLimits: usage };
}
/**
 * Get usage data (with caching)
 *
 * Returns a UsageResult with:
 * - rateLimits: RateLimits on success, null on failure/no credentials
 * - error: categorized reason when API call fails (undefined on success or no credentials)
 *   - 'network': API call failed (timeout, HTTP error, parse error)
 *   - 'auth': credentials expired and refresh failed
 *   - 'no_credentials': no OAuth credentials available (expected for API key users)
 *   - 'rate_limited': API returned 429; stale data served if available, with exponential backoff
 */
export async function getUsage() {
    const baseUrl = process.env.ANTHROPIC_BASE_URL;
    const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
    const isMinimax = baseUrl != null && isMinimaxHost(baseUrl);
    const isZai = baseUrl != null && isZaiHost(baseUrl);
    const minimaxApiKey = process.env.MINIMAX_API_KEY || authToken;
    const currentSource = isMinimax ? 'minimax' : isZai && authToken ? 'zai' : 'anthropic';
    const pollIntervalMs = getUsagePollIntervalMs();
    // Migrate legacy single-file cache to provider-specific file (one-shot, best-effort)
    migrateLegacyCache(currentSource);
    const initialCache = readCache(currentSource);
    if (initialCache && isCacheValid(initialCache, pollIntervalMs) && initialCache.source === currentSource) {
        return getCachedUsageResult(initialCache);
    }
    try {
        return await withFileLock(lockPathFor(getCachePath(currentSource)), async () => {
            const cache = readCache(currentSource);
            if (cache && isCacheValid(cache, pollIntervalMs) && cache.source === currentSource) {
                return getCachedUsageResult(cache);
            }
            // MiniMax path (must precede z.ai and OAuth checks)
            if (isMinimax) {
                if (!minimaxApiKey) {
                    writeCache({ data: null, error: true, source: 'minimax', errorReason: 'no_credentials' });
                    return { rateLimits: null, error: 'no_credentials' };
                }
                return fetchAndCacheUsage({
                    source: 'minimax',
                    fetchFn: () => fetchUsageFromMinimax(minimaxApiKey),
                    parseFn: parseMinimaxResponse,
                    cache,
                    pollIntervalMs,
                });
            }
            // z.ai path (must precede OAuth check to avoid stale Anthropic credentials)
            if (isZai && authToken) {
                return fetchAndCacheUsage({
                    source: 'zai',
                    fetchFn: () => fetchUsageFromZai(),
                    parseFn: parseZaiResponse,
                    cache,
                    pollIntervalMs,
                });
            }
            // Anthropic OAuth path (official Claude Code support)
            let creds = getCredentials();
            if (creds) {
                if (!validateCredentials(creds)) {
                    if (creds.refreshToken) {
                        const refreshed = await refreshAccessToken(creds.refreshToken);
                        if (refreshed) {
                            creds = { ...creds, ...refreshed };
                            writeBackCredentials(creds);
                        }
                        else {
                            writeCache({ data: null, error: true, source: 'anthropic', errorReason: 'auth' });
                            return { rateLimits: null, error: 'auth' };
                        }
                    }
                    else {
                        writeCache({ data: null, error: true, source: 'anthropic', errorReason: 'auth' });
                        return { rateLimits: null, error: 'auth' };
                    }
                }
                const accessToken = creds.accessToken;
                const subscriptionType = creds.subscriptionType;
                const rateLimitTier = creds.rateLimitTier;
                return fetchAndCacheUsage({
                    source: 'anthropic',
                    fetchFn: () => fetchUsageFromApi(accessToken),
                    parseFn: (data) => parseUsageResponse(data, {
                        subscriptionType,
                        rateLimitTier,
                    }),
                    cache,
                    pollIntervalMs,
                });
            }
            writeCache({ data: null, error: true, source: 'anthropic', errorReason: 'no_credentials' });
            return { rateLimits: null, error: 'no_credentials' };
        }, USAGE_CACHE_LOCK_OPTS);
    }
    catch (err) {
        // Lock acquisition failed — return stale cache without touching the cache file
        // to avoid racing with the lock holder writing fresh data
        if (err instanceof Error && err.message.startsWith('Failed to acquire file lock')) {
            if (initialCache?.data) {
                return { rateLimits: initialCache.data, stale: true };
            }
            return { rateLimits: null, error: 'network' };
        }
        return { rateLimits: null, error: 'network' };
    }
}
//# sourceMappingURL=usage-api.js.map