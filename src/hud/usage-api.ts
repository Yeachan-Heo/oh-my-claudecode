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
import { getClaudeConfigDir } from '../utils/paths.js';
import { join, dirname } from 'path';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { userInfo } from 'os';
import https from 'https';
import { validateAnthropicBaseUrl } from '../utils/ssrf-guard.js';
import {
  DEFAULT_HUD_USAGE_POLL_INTERVAL_MS,
  type RateLimits,
  type UsageResult,
  type UsageErrorReason,
} from './types.js';
import { readHudConfig } from './state.js';
import { lockPathFor, withFileLock, type FileLockOptions } from '../lib/file-lock.js';

// Cache configuration
const CACHE_TTL_FAILURE_MS = 15 * 1000; // 15 seconds for non-transient failures
const CACHE_TTL_TRANSIENT_NETWORK_MS = 2 * 60 * 1000; // 2 minutes to avoid hammering transient API failures
const MAX_RATE_LIMITED_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes max for sustained 429s
const API_TIMEOUT_MS = 10000;
const MAX_STALE_DATA_MS = 15 * 60 * 1000; // 15 minutes — discard stale data after this
const TOKEN_REFRESH_URL_HOSTNAME = 'platform.claude.com';
const USAGE_CACHE_LOCK_OPTS: FileLockOptions = { staleLockMs: API_TIMEOUT_MS + 5000 };
const TOKEN_REFRESH_URL_PATH = '/v1/oauth/token';

/**
 * OAuth client_id for Claude Code (public client).
 * This is the production value; can be overridden via CLAUDE_CODE_OAUTH_CLIENT_ID env var.
 */
const DEFAULT_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

interface UsageCache {
  timestamp: number;
  data: RateLimits | null;
  error?: boolean;
  /** Preserved error reason for accurate cache-hit reporting */
  errorReason?: UsageErrorReason;
  /** Provider that produced this cache entry */
  source?: 'anthropic' | 'zai';
  /** Whether this cache entry was caused by a 429 rate limit response */
  rateLimited?: boolean;
  /** Consecutive 429 count for exponential backoff */
  rateLimitedCount?: number;
  /** Absolute timestamp when the next rate-limited retry is allowed */
  rateLimitedUntil?: number;
  /** Timestamp of the last successful API fetch (drives stale data cutoff) */
  lastSuccessAt?: number;
}

interface OAuthCredentials {
  accessToken: string;
  expiresAt?: number;
  refreshToken?: string;
  /** Where the credentials were read from, needed for write-back */
  source?: 'keychain' | 'file';
}

interface UsageApiResponse {
  five_hour?: { utilization?: number; resets_at?: string };
  seven_day?: { utilization?: number; resets_at?: string };
  // Per-model quotas (flat structure at top level)
  seven_day_sonnet?: { utilization?: number; resets_at?: string };
  seven_day_opus?: { utilization?: number; resets_at?: string };
}

interface ZaiQuotaResponse {
  data?: {
    limits?: Array<{
      type: string;           // 'TOKENS_LIMIT' | 'TIME_LIMIT'
      percentage: number;     // 0-100
      remain_count?: number;
      quota_count?: number;
      currentValue?: number;
      usage?: number;
      nextResetTime?: number; // Unix timestamp in milliseconds
    }>;
  };
}

/**
 * Check if a URL points to z.ai (exact hostname match)
 */
export function isZaiHost(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    const hostname = url.hostname.toLowerCase();
    return hostname === 'z.ai' || hostname.endsWith('.z.ai');
  } catch {
    return false;
  }
}

/**
 * Get the cache file path
 */
function getCachePath(): string {
  return join(getClaudeConfigDir(), 'plugins', 'oh-my-claudecode', '.usage-cache.json');
}

/**
 * Read cached usage data
 */
function readCache(): UsageCache | null {
  try {
    const cachePath = getCachePath();
    if (!existsSync(cachePath)) return null;

    const content = readFileSync(cachePath, 'utf-8');
    const cache = JSON.parse(content) as UsageCache;

    // Re-hydrate Date objects from JSON strings
    if (cache.data) {
      if (cache.data.fiveHourResetsAt) {
        cache.data.fiveHourResetsAt = new Date(cache.data.fiveHourResetsAt as unknown as string);
      }
      if (cache.data.weeklyResetsAt) {
        cache.data.weeklyResetsAt = new Date(cache.data.weeklyResetsAt as unknown as string);
      }
      if (cache.data.sonnetWeeklyResetsAt) {
        cache.data.sonnetWeeklyResetsAt = new Date(cache.data.sonnetWeeklyResetsAt as unknown as string);
      }
      if (cache.data.opusWeeklyResetsAt) {
        cache.data.opusWeeklyResetsAt = new Date(cache.data.opusWeeklyResetsAt as unknown as string);
      }
      if (cache.data.monthlyResetsAt) {
        cache.data.monthlyResetsAt = new Date(cache.data.monthlyResetsAt as unknown as string);
      }
    }

    return cache;
  } catch {
    return null;
  }
}

/**
 * Options for writing usage data to cache
 */
interface WriteCacheOptions {
  data: RateLimits | null;
  error?: boolean;
  source?: 'anthropic' | 'zai';
  rateLimited?: boolean;
  rateLimitedCount?: number;
  rateLimitedUntil?: number;
  errorReason?: UsageErrorReason;
  lastSuccessAt?: number;
}

/**
 * Write usage data to cache
 */
function writeCache(opts: WriteCacheOptions): void {
  try {
    const cachePath = getCachePath();
    const cacheDir = dirname(cachePath);

    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }

    const cache: UsageCache = {
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
  } catch {
    // Ignore cache write errors
  }
}

/**
 * Check if cache is still valid
 */
function sanitizePollIntervalMs(value: number | undefined): number {
  if (value == null || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_HUD_USAGE_POLL_INTERVAL_MS;
  }

  return Math.max(1000, Math.floor(value));
}

function getUsagePollIntervalMs(): number {
  try {
    return sanitizePollIntervalMs(readHudConfig().usageApiPollIntervalMs);
  } catch {
    return DEFAULT_HUD_USAGE_POLL_INTERVAL_MS;
  }
}

function getRateLimitedBackoffMs(pollIntervalMs: number, count: number): number {
  const normalizedPollIntervalMs = sanitizePollIntervalMs(pollIntervalMs);
  return Math.min(
    normalizedPollIntervalMs * Math.pow(2, Math.max(0, count - 1)),
    Math.max(MAX_RATE_LIMITED_BACKOFF_MS, normalizedPollIntervalMs),
  );
}

function getTransientNetworkBackoffMs(pollIntervalMs: number): number {
  return Math.max(CACHE_TTL_TRANSIENT_NETWORK_MS, sanitizePollIntervalMs(pollIntervalMs));
}

function isCacheValid(cache: UsageCache, pollIntervalMs: number): boolean {
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

function hasUsableStaleData(cache: UsageCache | null | undefined): cache is UsageCache & { data: RateLimits } {
  if (!cache?.data) {
    return false;
  }

  if (cache.lastSuccessAt && Date.now() - cache.lastSuccessAt > MAX_STALE_DATA_MS) {
    return false;
  }

  return true;
}

function getCachedUsageResult(cache: UsageCache): UsageResult {
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

function createRateLimitedCacheEntry(
  source: 'anthropic' | 'zai',
  data: RateLimits | null,
  pollIntervalMs: number,
  previousCount: number,
  lastSuccessAt?: number,
): UsageCache {
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
 * Claude Code uses "Claude Code-credentials-{sha256(configDir)[:8]}" for non-default dirs.
 */
function getKeychainServiceName(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (configDir) {
    const hash = createHash('sha256').update(configDir).digest('hex').slice(0, 8);
    return `Claude Code-credentials-${hash}`;
  }
  return 'Claude Code-credentials';
}

function isCredentialExpired(creds: OAuthCredentials): boolean {
  return creds.expiresAt != null && creds.expiresAt <= Date.now();
}

function readKeychainCredential(serviceName: string, account?: string): OAuthCredentials | null {
  try {
    const accountArg = account ? ` -a "${account}"` : '';
    const result = execSync(
      `/usr/bin/security find-generic-password -s "${serviceName}"${accountArg} -w 2>/dev/null`,
      { encoding: 'utf-8', timeout: 2000 }
    ).trim();

    if (!result) return null;

    const parsed = JSON.parse(result);

    // Handle nested structure (claudeAiOauth wrapper)
    const creds = parsed.claudeAiOauth || parsed;

    if (!creds.accessToken) return null;

    return {
      accessToken: creds.accessToken,
      expiresAt: creds.expiresAt,
      refreshToken: creds.refreshToken,
      source: 'keychain' as const,
    };
  } catch {
    return null;
  }
}

/**
 * Read OAuth credentials from macOS Keychain
 */
function readKeychainCredentials(): OAuthCredentials | null {
  if (process.platform !== 'darwin') return null;

  const serviceName = getKeychainServiceName();
  const candidateAccounts: Array<string | undefined> = [];

  try {
    const username = userInfo().username?.trim();
    if (username) {
      candidateAccounts.push(username);
    }
  } catch {
    // Best-effort only; fall back to the legacy service-only lookup below.
  }

  candidateAccounts.push(undefined);

  let expiredFallback: OAuthCredentials | null = null;

  for (const account of candidateAccounts) {
    const creds = readKeychainCredential(serviceName, account);
    if (!creds) continue;

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
function readFileCredentials(): OAuthCredentials | null {
  try {
    const credPath = join(getClaudeConfigDir(), '.credentials.json');
    if (!existsSync(credPath)) return null;

    const content = readFileSync(credPath, 'utf-8');
    const parsed = JSON.parse(content);

    // Handle nested structure (claudeAiOauth wrapper)
    const creds = parsed.claudeAiOauth || parsed;

    if (creds.accessToken) {
      return {
        accessToken: creds.accessToken,
        expiresAt: creds.expiresAt,
        refreshToken: creds.refreshToken,
        source: 'file' as const,
      };
    }
  } catch {
    // File read failed
  }

  return null;
}

/**
 * Get OAuth credentials (Keychain first, then file fallback)
 */
function getCredentials(): OAuthCredentials | null {
  // Try Keychain first (macOS)
  const keychainCreds = readKeychainCredentials();
  if (keychainCreds) return keychainCreds;

  // Fall back to file
  return readFileCredentials();
}

/**
 * Validate credentials are not expired
 */
function validateCredentials(creds: OAuthCredentials): boolean {
  if (!creds.accessToken) return false;

  return !isCredentialExpired(creds);
}

/**
 * Attempt to refresh an expired OAuth access token using the refresh token.
 * Returns updated credentials on success, null on failure.
 */
function refreshAccessToken(refreshToken: string): Promise<OAuthCredentials | null> {
  return new Promise((resolve) => {
    const clientId = process.env.CLAUDE_CODE_OAUTH_CLIENT_ID || DEFAULT_OAUTH_CLIENT_ID;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    }).toString();

    const req = https.request(
      {
        hostname: TOKEN_REFRESH_URL_HOSTNAME,
        path: TOKEN_REFRESH_URL_PATH,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: API_TIMEOUT_MS,
      },
      (res) => {
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
            } catch {
              // JSON parse failed
            }
          }
          if (process.env.OMC_DEBUG) {
            console.error(`[usage-api] Token refresh failed: HTTP ${res.statusCode}`);
          }
          resolve(null);
        });
      }
    );

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end(body);
  });
}

interface FetchResult<T> {
  data: T | null;
  rateLimited?: boolean;
}

/**
 * Fetch usage from Anthropic API
 */
function fetchUsageFromApi(accessToken: string): Promise<FetchResult<UsageApiResponse>> {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/api/oauth/usage',
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'Content-Type': 'application/json',
        },
        timeout: API_TIMEOUT_MS,
      },
      (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              resolve({ data: JSON.parse(data) });
            } catch {
              resolve({ data: null });
            }
          } else if (res.statusCode === 429) {
            if (process.env.OMC_DEBUG) {
              console.error(`[usage-api] Anthropic API returned 429 (rate limited)`);
            }
            resolve({ data: null, rateLimited: true });
          } else {
            resolve({ data: null });
          }
        });
      }
    );

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
function fetchUsageFromZai(): Promise<FetchResult<ZaiQuotaResponse>> {
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

      const req = https.request(
        {
          hostname: urlObj.hostname,
          path: urlObj.pathname,
          method: 'GET',
          headers: {
            'Authorization': authToken,
            'Content-Type': 'application/json',
            'Accept-Language': 'en-US,en',
          },
          timeout: API_TIMEOUT_MS,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            if (res.statusCode === 200) {
              try {
                resolve({ data: JSON.parse(data) });
              } catch {
                resolve({ data: null });
              }
            } else if (res.statusCode === 429) {
              if (process.env.OMC_DEBUG) {
                console.error(`[usage-api] z.ai API returned 429 (rate limited)`);
              }
              resolve({ data: null, rateLimited: true });
            } else {
              resolve({ data: null });
            }
          });
        }
      );

      req.on('error', () => resolve({ data: null }));
      req.on('timeout', () => { req.destroy(); resolve({ data: null }); });
      req.end();
    } catch {
      resolve({ data: null });
    }
  });
}

/**
 * Persist refreshed credentials back to the file-based credential store.
 * Keychain write-back is not supported (read-only for HUD).
 * Updates only the claudeAiOauth fields, preserving other data.
 */
function writeBackCredentials(creds: OAuthCredentials): void {
  try {
    const credPath = join(getClaudeConfigDir(), '.credentials.json');
    if (!existsSync(credPath)) return;

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
    } else {
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
    } catch (writeErr) {
      // Clean up orphaned tmp file on failure
      try {
        if (existsSync(tmpPath)) {
          unlinkSync(tmpPath);
        }
      } catch {
        // Ignore cleanup errors
      }
      throw writeErr;
    }
  } catch {
    // Silent failure - credential write-back is best-effort
    if (process.env.OMC_DEBUG) {
      console.error('[usage-api] Failed to write back refreshed credentials');
    }
  }
}

/**
 * Clamp values to 0-100 and filter invalid
 */
function clamp(v: number | undefined): number {
  if (v == null || !isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

/**
 * Parse API response into RateLimits
 */
function parseUsageResponse(response: UsageApiResponse): RateLimits | null {
  const fiveHour = response.five_hour?.utilization;
  const sevenDay = response.seven_day?.utilization;

  // Need at least one valid value
  if (fiveHour == null && sevenDay == null) return null;

  // Parse ISO 8601 date strings to Date objects
  const parseDate = (dateStr: string | undefined): Date | null => {
    if (!dateStr) return null;
    try {
      const date = new Date(dateStr);
      return isNaN(date.getTime()) ? null : date;
    } catch {
      return null;
    }
  };

  // Per-model quotas are at the top level (flat structure)
  // e.g., response.seven_day_sonnet, response.seven_day_opus
  const sonnetSevenDay = response.seven_day_sonnet?.utilization;
  const sonnetResetsAt = response.seven_day_sonnet?.resets_at;

  const result: RateLimits = {
    fiveHourPercent: clamp(fiveHour),
    weeklyPercent: clamp(sevenDay),
    fiveHourResetsAt: parseDate(response.five_hour?.resets_at),
    weeklyResetsAt: parseDate(response.seven_day?.resets_at),
  };

  // Add Sonnet-specific quota if available from API
  if (sonnetSevenDay != null) {
    result.sonnetWeeklyPercent = clamp(sonnetSevenDay);
    result.sonnetWeeklyResetsAt = parseDate(sonnetResetsAt);
  }

  // Add Opus-specific quota if available from API
  const opusSevenDay = response.seven_day_opus?.utilization;
  const opusResetsAt = response.seven_day_opus?.resets_at;
  if (opusSevenDay != null) {
    result.opusWeeklyPercent = clamp(opusSevenDay);
    result.opusWeeklyResetsAt = parseDate(opusResetsAt);
  }

  return result;
}

/**
 * Parse z.ai API response into RateLimits
 */
export function parseZaiResponse(response: ZaiQuotaResponse): RateLimits | null {
  const limits = response.data?.limits;
  if (!limits || limits.length === 0) return null;

  const tokensLimit = limits.find(l => l.type === 'TOKENS_LIMIT');
  const timeLimit = limits.find(l => l.type === 'TIME_LIMIT');

  if (!tokensLimit && !timeLimit) return null;

  // Parse nextResetTime (Unix timestamp in milliseconds) to Date
  const parseResetTime = (timestamp: number | undefined): Date | null => {
    if (!timestamp) return null;
    try {
      const date = new Date(timestamp);
      return isNaN(date.getTime()) ? null : date;
    } catch {
      return null;
    }
  };

  return {
    fiveHourPercent: clamp(tokensLimit?.percentage),
    fiveHourResetsAt: parseResetTime(tokensLimit?.nextResetTime),
    // z.ai has no weekly quota; leave weeklyPercent undefined so HUD hides it
    monthlyPercent: timeLimit ? clamp(timeLimit.percentage) : undefined,
    monthlyResetsAt: timeLimit ? (parseResetTime(timeLimit.nextResetTime) ?? null) : undefined,
  };
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
export async function getUsage(): Promise<UsageResult> {
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const isZai = baseUrl != null && isZaiHost(baseUrl);
  const currentSource: 'anthropic' | 'zai' = isZai && authToken ? 'zai' : 'anthropic';
  const pollIntervalMs = getUsagePollIntervalMs();

  const initialCache = readCache();
  if (initialCache && isCacheValid(initialCache, pollIntervalMs) && initialCache.source === currentSource) {
    return getCachedUsageResult(initialCache);
  }

  try {
    return await withFileLock(lockPathFor(getCachePath()), async () => {
      const cache = readCache();
      if (cache && isCacheValid(cache, pollIntervalMs) && cache.source === currentSource) {
        return getCachedUsageResult(cache);
      }

      // z.ai path (must precede OAuth check to avoid stale Anthropic credentials)
      if (isZai && authToken) {
        const result = await fetchUsageFromZai();
        const cachedZai = cache?.source === 'zai' ? cache : null;

        if (result.rateLimited) {
          const prevLastSuccess = cachedZai?.lastSuccessAt;
          const rateLimitedCache = createRateLimitedCacheEntry('zai', cachedZai?.data || null, pollIntervalMs, cachedZai?.rateLimitedCount || 0, prevLastSuccess);
          writeCache({
            data: rateLimitedCache.data,
            error: rateLimitedCache.error,
            source: rateLimitedCache.source,
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
          const fallbackData = hasUsableStaleData(cachedZai) ? cachedZai.data : null;
          writeCache({
            data: fallbackData,
            error: true,
            source: 'zai',
            errorReason: 'network',
            lastSuccessAt: cachedZai?.lastSuccessAt,
          });
          if (fallbackData) {
            return { rateLimits: fallbackData, error: 'network', stale: true };
          }
          return { rateLimits: null, error: 'network' };
        }

        const usage = parseZaiResponse(result.data);
        writeCache({ data: usage, error: !usage, source: 'zai', lastSuccessAt: Date.now() });
        return { rateLimits: usage };
      }

      // Anthropic OAuth path (official Claude Code support)
      let creds = getCredentials();
      if (creds) {
        const cachedAnthropic = cache?.source === 'anthropic' ? cache : null;
        if (!validateCredentials(creds)) {
          if (creds.refreshToken) {
            const refreshed = await refreshAccessToken(creds.refreshToken);
            if (refreshed) {
              creds = { ...creds, ...refreshed };
              writeBackCredentials(creds);
            } else {
              writeCache({ data: null, error: true, source: 'anthropic', errorReason: 'auth' });
              return { rateLimits: null, error: 'auth' };
            }
          } else {
            writeCache({ data: null, error: true, source: 'anthropic', errorReason: 'auth' });
            return { rateLimits: null, error: 'auth' };
          }
        }

        const result = await fetchUsageFromApi(creds.accessToken);

        if (result.rateLimited) {
          const prevLastSuccess = cachedAnthropic?.lastSuccessAt;
          const rateLimitedCache = createRateLimitedCacheEntry('anthropic', cachedAnthropic?.data || null, pollIntervalMs, cachedAnthropic?.rateLimitedCount || 0, prevLastSuccess);
          writeCache({
            data: rateLimitedCache.data,
            error: rateLimitedCache.error,
            source: rateLimitedCache.source,
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
          const fallbackData = hasUsableStaleData(cachedAnthropic) ? cachedAnthropic.data : null;
          writeCache({
            data: fallbackData,
            error: true,
            source: 'anthropic',
            errorReason: 'network',
            lastSuccessAt: cachedAnthropic?.lastSuccessAt,
          });
          if (fallbackData) {
            return { rateLimits: fallbackData, error: 'network', stale: true };
          }
          return { rateLimits: null, error: 'network' };
        }

        const usage = parseUsageResponse(result.data);
        writeCache({ data: usage, error: !usage, source: 'anthropic', lastSuccessAt: Date.now() });
        return { rateLimits: usage };
      }

      writeCache({ data: null, error: true, source: 'anthropic', errorReason: 'no_credentials' });
      return { rateLimits: null, error: 'no_credentials' };
    }, USAGE_CACHE_LOCK_OPTS);
  } catch (err) {
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
