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
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { getClaudeConfigDir } from '../utils/config-dir.js';
const CACHE_TTL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 800;
function getCachePath() {
    return join(getClaudeConfigDir(), 'plugins', 'oh-my-claudecode', '.custom-rate-cache.json');
}
function readCache() {
    try {
        const p = getCachePath();
        if (!existsSync(p))
            return null;
        return JSON.parse(readFileSync(p, 'utf-8'));
    }
    catch {
        return null;
    }
}
function writeCache(buckets, identity) {
    try {
        const p = getCachePath();
        const dir = dirname(p);
        if (!existsSync(dir))
            mkdirSync(dir, { recursive: true });
        const cache = { timestamp: Date.now(), buckets, identity };
        writeFileSync(p, JSON.stringify(cache, null, 2));
    }
    catch {
        // Silent failure — cache is best-effort
    }
}
function isCacheValid(cache) {
    return Date.now() - cache.timestamp < CACHE_TTL_MS;
}
/**
 * Spawn a command with a hard timeout.
 *
 * Sends SIGTERM when the timeout fires, then SIGKILL after 200 ms if still
 * alive. The returned promise rejects on non-zero exit or timeout.
 */
export function spawnWithTimeout(cmd, timeoutMs) {
    return new Promise((resolve, reject) => {
        const [executable, ...args] = Array.isArray(cmd)
            ? cmd
            : ['sh', '-c', cmd];
        const child = spawn(executable, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
        });
        const killTree = (signal) => {
            if (child.pid === undefined)
                return;
            try {
                if (process.platform === 'win32') {
                    child.kill(signal);
                }
                else {
                    process.kill(-child.pid, signal);
                }
            }
            catch {
                // The process group may already have exited.
            }
        };
        // Consume diagnostics without retaining them so a full stderr pipe cannot
        // block the command before it writes its JSON result to stdout.
        child.stderr.on('data', () => { });
        let stdout = '';
        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        let timedOut = false;
        let escalationTimer;
        const timer = setTimeout(() => {
            timedOut = true;
            killTree('SIGTERM');
            child.stdout.destroy();
            child.stderr.destroy();
            escalationTimer = setTimeout(() => killTree('SIGKILL'), 200);
            reject(new Error(`Custom rate limit command timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        child.on('close', (code) => {
            clearTimeout(timer);
            if (!timedOut && escalationTimer)
                clearTimeout(escalationTimer);
            if (!timedOut) {
                if (code === 0) {
                    resolve(stdout);
                }
                else {
                    reject(new Error(`Command exited with code ${code}`));
                }
            }
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            if (!timedOut)
                reject(err);
        });
    });
}
/**
 * Parse and validate the command's stdout.
 * Returns the filtered bucket array, or null if the output is malformed.
 */
function parseOutput(raw, periods) {
    let parsed;
    try {
        parsed = JSON.parse(raw.trim());
    }
    catch {
        return null;
    }
    if (typeof parsed !== 'object' ||
        parsed === null ||
        parsed.version !== 1 ||
        !Array.isArray(parsed.buckets)) {
        return null;
    }
    const buckets = parsed.buckets.filter((b) => {
        if (typeof b.id !== 'string' || typeof b.label !== 'string')
            return false;
        if (!b.usage || typeof b.usage.type !== 'string')
            return false;
        const u = b.usage;
        if (u.type === 'percent')
            return typeof u.value === 'number';
        if (u.type === 'credit') {
            return (typeof u.used === 'number' &&
                typeof u.limit === 'number');
        }
        if (u.type === 'string')
            return typeof u.value === 'string';
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
export async function executeCustomProvider(config) {
    // Period order and duplicates do not affect the existing membership filter.
    const identity = createHash('sha256').update(JSON.stringify({
        command: config.command, periods: [...new Set(config.periods ?? [])].sort(),
    })).digest('hex');
    const storedCache = readCache();
    const cache = storedCache?.identity === identity ? storedCache : null;
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
            if (cache)
                return { buckets: cache.buckets, stale: true };
            return { buckets: [], stale: false, error: 'invalid output' };
        }
        writeCache(buckets, identity);
        return { buckets, stale: false };
    }
    catch (err) {
        if (process.env.OMC_DEBUG) {
            console.error('[custom-rate-provider] Command failed:', err instanceof Error ? err.message : err);
        }
        if (cache)
            return { buckets: cache.buckets, stale: true };
        return { buckets: [], stale: false, error: 'command failed' };
    }
}
//# sourceMappingURL=custom-rate-provider.js.map