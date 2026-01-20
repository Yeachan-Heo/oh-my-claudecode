/**
 * Sisyphus HUD - Usage API
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

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { execSync } from 'child_process';
import https from 'https';
import type { RateLimits } from './types.js';

// Cache configuration
const CACHE_TTL_SUCCESS_MS = 60 * 1000; // 60 seconds for successful responses
const CACHE_TTL_FAILURE_MS = 15 * 1000; // 15 seconds for failures
const API_TIMEOUT_MS = 5000;

interface UsageCache {
  timestamp: number;
  data: RateLimits | null;
  error?: boolean;
}

interface OAuthCredentials {
  accessToken: string;
  expiresAt?: number;
}

interface UsageApiResponse {
  five_hour?: { utilization?: number; resets_at?: string };
  seven_day?: { utilization?: number; resets_at?: string };
}

/**
 * Get the cache file path
 */
function getCachePath(): string {
  return join(homedir(), '.claude/plugins/oh-my-claudecode/.usage-cache.json');
}

/**
 * Read cached usage data
 */
function readCache(): UsageCache | null {
  try {
    const cachePath = getCachePath();
    if (!existsSync(cachePath)) return null;

    const content = readFileSync(cachePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Write usage data to cache
 */
function writeCache(data: RateLimits | null, error = false): void {
  try {
    const cachePath = getCachePath();
    const cacheDir = dirname(cachePath);

    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }

    const cache: UsageCache = {
      timestamp: Date.now(),
      data,
      error,
    };

    writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  } catch {
    // Ignore cache write errors
  }
}

/**
 * Check if cache is still valid
 */
function isCacheValid(cache: UsageCache): boolean {
  const ttl = cache.error ? CACHE_TTL_FAILURE_MS : CACHE_TTL_SUCCESS_MS;
  return Date.now() - cache.timestamp < ttl;
}

/**
 * Read OAuth credentials from macOS Keychain
 */
function readKeychainCredentials(): OAuthCredentials | null {
  if (process.platform !== 'darwin') return null;

  try {
    const result = execSync(
      '/usr/bin/security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
      { encoding: 'utf-8', timeout: 2000 }
    ).trim();

    if (!result) return null;

    const parsed = JSON.parse(result);
    if (parsed.accessToken) {
      return {
        accessToken: parsed.accessToken,
        expiresAt: parsed.expiresAt,
      };
    }
  } catch {
    // Keychain access failed
  }

  return null;
}

/**
 * Read OAuth credentials from file fallback
 */
function readFileCredentials(): OAuthCredentials | null {
  try {
    const credPath = join(homedir(), '.claude/.credentials.json');
    if (!existsSync(credPath)) return null;

    const content = readFileSync(credPath, 'utf-8');
    const parsed = JSON.parse(content);

    if (parsed.accessToken) {
      return {
        accessToken: parsed.accessToken,
        expiresAt: parsed.expiresAt,
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

  if (creds.expiresAt != null) {
    const now = Date.now();
    if (creds.expiresAt <= now) return false;
  }

  return true;
}

/**
 * Fetch usage from Anthropic API
 */
function fetchUsageFromApi(accessToken: string): Promise<UsageApiResponse | null> {
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
              resolve(JSON.parse(data));
            } catch {
              resolve(null);
            }
          } else {
            resolve(null);
          }
        });
      }
    );

    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });

    req.end();
  });
}

/**
 * Parse API response into RateLimits
 */
function parseUsageResponse(response: UsageApiResponse): RateLimits | null {
  const fiveHour = response.five_hour?.utilization;
  const sevenDay = response.seven_day?.utilization;

  // Need at least one valid value
  if (fiveHour == null && sevenDay == null) return null;

  // Clamp values to 0-100 and filter invalid
  const clamp = (v: number | undefined): number => {
    if (v == null || !isFinite(v)) return 0;
    return Math.max(0, Math.min(100, v));
  };

  return {
    fiveHourPercent: clamp(fiveHour),
    weeklyPercent: clamp(sevenDay),
  };
}

/**
 * Get usage data (with caching)
 *
 * Returns null if:
 * - No OAuth credentials available (API users)
 * - Credentials expired
 * - API call failed
 */
export async function getUsage(): Promise<RateLimits | null> {
  // Check cache first
  const cache = readCache();
  if (cache && isCacheValid(cache)) {
    return cache.data;
  }

  // Get credentials
  const creds = getCredentials();
  if (!creds || !validateCredentials(creds)) {
    writeCache(null, true);
    return null;
  }

  // Fetch from API
  const response = await fetchUsageFromApi(creds.accessToken);
  if (!response) {
    writeCache(null, true);
    return null;
  }

  // Parse response
  const usage = parseUsageResponse(response);
  writeCache(usage, !usage);

  return usage;
}
