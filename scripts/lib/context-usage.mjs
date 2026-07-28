import { existsSync, openSync, readFileSync, readSync, statSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const TRANSCRIPT_TAIL_BYTES = 4096;
const HUD_CACHE_FILENAME = 'hud-stdin-cache.json';

// Same priority order as SESSION_ID_ENV_VARS in src/hud/stdin.ts, so this
// resolver picks the same session identity the HUD itself would use.
const SESSION_ID_ENV_VARS = ['CLAUDE_SESSION_ID', 'CLAUDECODE_SESSION_ID'];

/**
 * List candidate session ids in the same priority order the HUD uses: the
 * current hook event's own payload first, then the session-id env vars in
 * priority order. Each candidate is tried in order by the caller — an
 * invalid or cache-less candidate must not stop the search, mirroring
 * src/hud/stdin.ts's getStdinCachePath, which skips an invalid env
 * candidate and tries the next one rather than giving up.
 */
function getSessionIdentityCandidates(data) {
  const candidates = [];
  const fromPayload = data?.session_id || data?.sessionId;
  if (typeof fromPayload === 'string' && fromPayload.trim()) {
    candidates.push(fromPayload.trim());
  }
  for (const envVar of SESSION_ID_ENV_VARS) {
    const candidate = process.env[envVar];
    if (typeof candidate === 'string' && candidate.trim()) {
      candidates.push(candidate.trim());
    }
  }
  return candidates;
}

function clampPercent(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * Resolve context usage reported directly by a hook event payload.
 * This preserves the #2412 fallback semantics used by the PostToolUse hook.
 */
export function resolveHookContextPercent(data) {
  const contextWindow = data?.context_window;
  if (!contextWindow || typeof contextWindow !== 'object') {
    return null;
  }

  const usedPercentage = contextWindow.used_percentage;
  if (Number.isFinite(usedPercentage) && usedPercentage >= 0) {
    return clampPercent(usedPercentage);
  }

  const size = contextWindow.context_window_size;
  if (!Number.isFinite(size) || size <= 0) {
    return null;
  }

  const usage = contextWindow.current_usage;
  if (!usage || typeof usage !== 'object') {
    return null;
  }

  const inputTokens = Number(usage.input_tokens || 0);
  const cacheCreationTokens = Number(usage.cache_creation_input_tokens || 0);
  const cacheReadTokens = Number(usage.cache_read_input_tokens || 0);
  const totalTokens = inputTokens + cacheCreationTokens + cacheReadTokens;
  if (!Number.isFinite(totalTokens) || totalTokens < 0) {
    return null;
  }

  return clampPercent((totalTokens / size) * 100);
}

function readJsonFile(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function hasContextWindowObject(data) {
  return Boolean(
    data &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    Object.prototype.hasOwnProperty.call(data, 'context_window') &&
    data.context_window &&
    typeof data.context_window === 'object' &&
    !Array.isArray(data.context_window),
  );
}

/**
 * Resolve context usage from the persisted HUD stdin cache.
 * The HUD's own getContextPercent implementation remains the source of truth
 * for percent calculation; this helper only locates and parses its cache.
 */
export async function resolveHudCacheContextPercent(data, directory) {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (!pluginRoot) return null;

  try {
    const worktreePaths = await import(
      pathToFileURL(join(pluginRoot, 'dist', 'lib', 'worktree-paths.js')).href,
    );
    const hudStdin = await import(
      pathToFileURL(join(pluginRoot, 'dist', 'hud', 'stdin.js')).href,
    );
    const { getWorktreeRoot, getSessionStateDir, listSessionIds, resolveOmcPath } = worktreePaths;
    const { getContextPercent } = hudStdin;
    if (
      typeof getWorktreeRoot !== 'function' ||
      typeof getSessionStateDir !== 'function' ||
      typeof listSessionIds !== 'function' ||
      typeof resolveOmcPath !== 'function' ||
      typeof getContextPercent !== 'function'
    ) {
      return null;
    }

    const root = getWorktreeRoot(directory || undefined) || directory || process.cwd();
    // Mirror the HUD's own session-identity resolution exactly
    // (src/hud/stdin.ts getStdinCachePath): walk the candidates — payload
    // session id first, then the env-var candidates in priority order —
    // and skip only a candidate that FAILS VALIDATION (getSessionStateDir
    // throws). The FIRST candidate that validates is authoritative and the
    // search stops there, exactly like getStdinCachePath: if that
    // identity's own cache is missing or unusable, return null immediately
    // rather than falling through to another (possibly concurrent,
    // unrelated) session's cache — matching readStdinCache's behavior of
    // returning null once a real session-scoped path was determined. Only
    // when NO candidate validates at all do we fall through to the
    // identity-less legacy/mtime recovery path below.
    for (const candidate of getSessionIdentityCandidates(data)) {
      let candidatePath;
      try {
        candidatePath = join(getSessionStateDir(candidate, root), HUD_CACHE_FILENAME);
      } catch {
        continue;
      }
      const cached = readJsonFile(candidatePath);
      if (!hasContextWindowObject(cached)) return null;
      return clampPercent(getContextPercent(cached));
    }

    // No candidate validated to a real identity at all: fall back exactly
    // as the HUD does for a fully identity-less reader — the legacy flat
    // cache first, then the most recently updated session-scoped cache as
    // a last resort (e.g. a detached watcher that never inherited session
    // env vars).
    let cached = readJsonFile(resolveOmcPath('state/' + HUD_CACHE_FILENAME, root));

    if (cached === null) {
      let bestPath = null;
      let bestMtime = -Infinity;
      let sessionIds;
      try {
        sessionIds = listSessionIds(root);
      } catch {
        sessionIds = [];
      }
      for (const sid of sessionIds) {
        let path;
        try {
          path = join(getSessionStateDir(sid, root), HUD_CACHE_FILENAME);
          const stats = statSync(path);
          if (!stats.isFile() || stats.mtimeMs <= bestMtime) continue;
          bestPath = path;
          bestMtime = stats.mtimeMs;
        } catch {
          // Skip missing, invalid, or unreadable session entries.
        }
      }
      if (bestPath) cached = readJsonFile(bestPath);
    }

    if (!hasContextWindowObject(cached)) return null;
    return clampPercent(getContextPercent(cached));
  } catch {
    return null;
  }
}

/**
 * Resolve context usage from the tail of a Claude transcript.
 * Transcript fixtures must include an explicit numeric context_window field;
 * real Claude transcripts commonly omit that field, in which case callers
 * should continue to the hook payload and HUD cache fallbacks.
 */
export function resolveTranscriptContextPercent(transcriptPath, tailBytes = TRANSCRIPT_TAIL_BYTES) {
  if (!transcriptPath) return null;

  let fd = -1;
  try {
    const stat = statSync(transcriptPath);
    if (stat.size === 0) return null;

    const readSize = Math.min(tailBytes, stat.size);
    if (readSize <= 0) return null;
    const buffer = Buffer.alloc(readSize);
    fd = openSync(transcriptPath, 'r');
    readSync(fd, buffer, 0, readSize, stat.size - readSize);
    closeSync(fd);
    fd = -1;

    const tail = buffer.toString('utf-8');
    const windowMatches = tail.match(/"context_window"\s{0,5}:\s{0,5}(\d+)/g);
    const inputMatches = tail.match(/"input_tokens"\s{0,5}:\s{0,5}(\d+)/g);
    if (!windowMatches || !inputMatches) return null;

    const cacheCreationMatches = tail.match(/"cache_creation_input_tokens"\s{0,5}:\s{0,5}(\d+)/g);
    const cacheReadMatches = tail.match(/"cache_read_input_tokens"\s{0,5}:\s{0,5}(\d+)/g);
    const lastWindow = Number.parseInt(
      windowMatches[windowMatches.length - 1].match(/(\d+)/)?.[1] || '0',
      10,
    );
    const lastInput = Number.parseInt(
      inputMatches[inputMatches.length - 1].match(/(\d+)/)?.[1] || '0',
      10,
    );
    const lastCacheCreation = Number.parseInt(
      cacheCreationMatches?.[cacheCreationMatches.length - 1].match(/(\d+)/)?.[1] || '0',
      10,
    );
    const lastCacheRead = Number.parseInt(
      cacheReadMatches?.[cacheReadMatches.length - 1].match(/(\d+)/)?.[1] || '0',
      10,
    );

    if (!Number.isFinite(lastWindow) || lastWindow <= 0) return null;
    if (!Number.isFinite(lastInput) || lastInput < 0) return null;
    if (!Number.isFinite(lastCacheCreation) || lastCacheCreation < 0) return null;
    if (!Number.isFinite(lastCacheRead) || lastCacheRead < 0) return null;

    return clampPercent(((lastInput + lastCacheCreation + lastCacheRead) / lastWindow) * 100);
  } catch {
    return null;
  } finally {
    if (fd !== -1) {
      try { closeSync(fd); } catch {}
    }
  }
}

/**
 * Resolve context usage from the best available source, in priority order.
 */
export async function resolveContextPercent(data, transcriptPath, directory) {
  const transcriptPercent = resolveTranscriptContextPercent(transcriptPath);
  if (transcriptPercent !== null) return transcriptPercent;

  const hookPercent = resolveHookContextPercent(data);
  if (hookPercent !== null) return hookPercent;

  return resolveHudCacheContextPercent(data, directory);
}
