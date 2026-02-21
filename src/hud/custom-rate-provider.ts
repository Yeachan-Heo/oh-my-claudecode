/**
 * OMC HUD - Custom Rate Limit Provider
 *
 * Executes a user-supplied command (omcHud.rateLimitsProvider) to fetch
 * rate limit / quota data and maps the output to CustomProviderResult.
 *
 * Output contract (stdout JSON):
 *   { version: 1, generatedAt: string, buckets: CustomBucket[] }
 *
 * Each bucket:
 *   { id, label, usage: {type, ...}, resetsAt? }
 *
 * Usage types:
 *   percent  – { type: 'percent', value: number }   → renders as "32%"
 *   credit   – { type: 'credit', used, limit }       → renders as "250/300"
 *   string   – { type: 'string', value: string }     → renders as-is
 *
 * Caching: last-good result is persisted for 30 s. On failure the stale
 * cache is returned (stale: true); if no cache exists, error is set.
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { getClaudeConfigDir } from '../utils/paths.js';
import type {
  RateLimitsProviderConfig,
  CustomBucket,
  CustomProviderOutput,
  CustomProviderResult,
} from './types.js';

const CACHE_TTL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 800;

interface CustomProviderCache {
  /** Unix timestamp (ms) of the last successful execution */
  timestamp: number;
  /** Buckets from the last successful execution */
  buckets: CustomBucket[];
}

function getCachePath(): string {
  return join(
    getClaudeConfigDir(),
    'plugins',
    'oh-my-claudecode',
    '.custom-rate-cache.json',
  );
}

function readCache(): CustomProviderCache | null {
  try {
    const p = getCachePath();
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf-8')) as CustomProviderCache;
  } catch {
    return null;
  }
}

function writeCache(buckets: CustomBucket[]): void {
  try {
    const p = getCachePath();
    const dir = dirname(p);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const cache: CustomProviderCache = { timestamp: Date.now(), buckets };
    writeFileSync(p, JSON.stringify(cache, null, 2));
  } catch {
    // Silent failure — cache is best-effort
  }
}

function isCacheValid(cache: CustomProviderCache): boolean {
  return Date.now() - cache.timestamp < CACHE_TTL_MS;
}

/**
 * Spawn a command with a hard timeout.
 *
 * Sends SIGTERM when the timeout fires, then SIGKILL after 200 ms if still
 * alive. The returned promise rejects on non-zero exit or timeout.
 */
function spawnWithTimeout(cmd: string | string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const [executable, ...args] = Array.isArray(cmd)
      ? cmd
      : (['sh', '-c', cmd] as string[]);

    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already exited
        }
      }, 200);
      reject(new Error(`Custom rate limit command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (!timedOut) {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Command exited with code ${code}`));
        }
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (!timedOut) reject(err);
    });
  });
}

/**
 * Parse and validate the command's stdout.
 * Returns the filtered bucket array, or null if the output is malformed.
 */
function parseOutput(raw: string, periods?: string[]): CustomBucket[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return null;
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as CustomProviderOutput).version !== 1 ||
    !Array.isArray((parsed as CustomProviderOutput).buckets)
  ) {
    return null;
  }

  const buckets = (parsed as CustomProviderOutput).buckets.filter((b) => {
    if (typeof b.id !== 'string' || typeof b.label !== 'string') return false;
    if (!b.usage || typeof b.usage.type !== 'string') return false;
    const u = b.usage;
    if (u.type === 'percent') return typeof (u as { value: unknown }).value === 'number';
    if (u.type === 'credit') {
      return (
        typeof (u as { used: unknown }).used === 'number' &&
        typeof (u as { limit: unknown }).limit === 'number'
      );
    }
    if (u.type === 'string') return typeof (u as { value: unknown }).value === 'string';
    return false;
  });

  // Apply period filter when configured
  if (periods && periods.length > 0) {
    return buckets.filter((b) => periods.includes(b.id));
  }
  return buckets;
}

/**
 * Execute the custom rate limit provider and return buckets.
 *
 * Behaviour:
 * - Returns fresh cached data if within 30-second TTL.
 * - On cache miss, spawns the command with the configured timeout.
 * - On success, writes cache and returns {buckets, stale: false}.
 * - On failure, returns last-good cache as {buckets, stale: true}.
 * - If no cache exists, returns {buckets: [], error: 'command failed'}.
 */
export async function executeCustomProvider(
  config: RateLimitsProviderConfig,
): Promise<CustomProviderResult> {
  const cache = readCache();

  // Return fresh cache
  if (cache && isCacheValid(cache)) {
    return { buckets: cache.buckets, stale: false };
  }

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const stdout = await spawnWithTimeout(config.command, timeoutMs);
    const buckets = parseOutput(stdout, config.periods);

    if (buckets === null) {
      if (process.env.OMC_DEBUG) {
        console.error('[custom-rate-provider] Invalid output format from command');
      }
      if (cache) return { buckets: cache.buckets, stale: true };
      return { buckets: [], stale: false, error: 'invalid output' };
    }

    writeCache(buckets);
    return { buckets, stale: false };
  } catch (err) {
    if (process.env.OMC_DEBUG) {
      console.error(
        '[custom-rate-provider] Command failed:',
        err instanceof Error ? err.message : err,
      );
    }
    if (cache) return { buckets: cache.buckets, stale: true };
    return { buckets: [], stale: false, error: 'command failed' };
  }
}
