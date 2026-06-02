/**
 * OMC HUD - Pull Request Element
 *
 * Renders the open PR for the current branch as `pr:#123 OPEN` (or `DRAFT`).
 *
 * Ported from the legacy omc-supplements.sh statusline wrapper. Because
 * `gh pr view` is a network call, it must never block a ~300ms statusline tick.
 * We mirror the fire-and-forget + file-cache pattern already used for session
 * summaries (see index.ts spawnSessionSummaryScript):
 *
 *   - readPrInfo()  reads a per-(cwd,branch) cache file synchronously (fast).
 *   - getPrInfo()   additionally kicks off a detached background `gh` refresh
 *                   when the cache is missing or older than the 30s TTL.
 *
 * The HUD always renders from whatever cache currently exists (possibly briefly
 * stale). Each statusline tick is a fresh process, so the only cross-tick
 * debounce is the cache file's mtime: we write an empty placeholder before
 * spawning so concurrent ticks don't all launch `gh`.
 */

import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dim, yellow, bold } from '../colors.js';
import { getClaudeConfigDir } from '../../utils/config-dir.js';
import type { PrInfo } from '../types.js';

const CACHE_TTL_MS = 30_000;

function getPrCacheDir(): string {
  return join(getClaudeConfigDir(), 'plugins', 'oh-my-claudecode', '.pr-cache');
}

function getPrCachePath(cwd: string, branch: string): string {
  const hash = createHash('sha1')
    .update(`${cwd}@${branch}`)
    .digest('hex')
    .slice(0, 16);
  return join(getPrCacheDir(), `${hash}.json`);
}

/**
 * Read the cached PR info for a (cwd, branch). Returns null when the cache is
 * missing, empty (the "checked, no open PR" marker), or unparseable.
 */
export function readPrInfo(cwd: string, branch: string): PrInfo | null {
  const path = getPrCachePath(cwd, branch);
  if (!existsSync(path)) return null;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8').trim();
  } catch {
    return null;
  }
  if (!raw) return null; // empty file = checked, no open PR

  try {
    const parsed = JSON.parse(raw) as Partial<PrInfo>;
    if (typeof parsed.number !== 'number') return null;
    return {
      number: parsed.number,
      state: typeof parsed.state === 'string' ? parsed.state : 'OPEN',
      isDraft: parsed.isDraft === true,
      title: typeof parsed.title === 'string' ? parsed.title : undefined,
    };
  } catch {
    return null;
  }
}

function cacheAgeMs(path: string): number {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Kick off a detached `gh pr view` refresh when the cache is stale.
 *
 * Writes an empty placeholder synchronously first so concurrent statusline
 * ticks (each a fresh process) see a fresh mtime and skip re-spawning. The
 * detached child atomically replaces the cache via a temp file + rename, or
 * leaves an empty file when the branch has no open PR. No-op on Windows
 * (relies on sh + gh, matching the legacy wrapper's environment).
 */
function refreshPrCacheIfStale(cwd: string, branch: string): void {
  if (process.platform === 'win32') return;

  const path = getPrCachePath(cwd, branch);
  if (cacheAgeMs(path) <= CACHE_TTL_MS) return;

  try {
    mkdirSync(getPrCacheDir(), { recursive: true });
    // Empty placeholder: renders nothing, but its fresh mtime debounces the
    // thundering herd of concurrent ticks until `gh` writes the real result.
    writeFileSync(path, '');
  } catch {
    return; // cannot write cache dir — skip refresh entirely
  }

  const tmp = `${path}.tmp`;
  // Run gh under an 8s watchdog so a hung gh (network stall, or an expired
  // token waiting on a prompt) can never outlive the 30s TTL and accumulate
  // one detached process per tick. The GH_*/GIT_TERMINAL_PROMPT env vars make
  // gh fail fast and non-interactively instead of blocking on a prompt.
  // Path interpolation is injection-safe: both paths are getPrCacheDir() plus a
  // fixed [0-9a-f]{16} hash basename — no branch/cwd text reaches the script.
  const script =
    `gh pr view --json number,state,title,isDraft > "${tmp}" 2>/dev/null & ghpid=$!; ` +
    `( sleep 8; kill "$ghpid" 2>/dev/null ) & wdpid=$!; ` +
    `wait "$ghpid" 2>/dev/null; kill "$wdpid" 2>/dev/null; ` +
    `if [ -s "${tmp}" ]; then mv "${tmp}" "${path}"; else : > "${path}"; rm -f "${tmp}"; fi`;
  try {
    const child = spawn('sh', ['-c', script], {
      cwd,
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: '1',
        GH_NO_UPDATE_NOTIFIER: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    });
    child.unref();
  } catch {
    // best-effort: a failed spawn just means no PR badge this cycle
  }
}

/**
 * Read the current git branch with a short timeout. Deliberately kept local
 * rather than importing getGitBranch from ./git.js: git.ts has a top-level
 * value import of DEFAULT_HUD_LABELS from ../types.js, so importing it would pull
 * types.ts (and its eager DEFAULT_HUD_CONFIG -> mission-board evaluation) into
 * index.ts's runtime graph. That both bloats the statusline import cost and
 * breaks index.ts tests that mock the mission-board module.
 */
function getCurrentBranch(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['branch', '--show-current'], {
      cwd,
      encoding: 'utf-8',
      timeout: 1000,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Get PR info for the current branch, refreshing the cache in the background
 * when stale. Returns the currently-cached PR (may be briefly stale) or null.
 */
export function getPrInfo(cwd: string): PrInfo | null {
  const branch = getCurrentBranch(cwd);
  if (!branch) return null;
  refreshPrCacheIfStale(cwd, branch);
  return readPrInfo(cwd, branch);
}

/**
 * Render the PR badge: `pr:#123 OPEN`. Draft PRs render `DRAFT` instead of the
 * raw state. Returns null when there is no PR for the current branch.
 */
export function renderPr(pr: PrInfo | null | undefined): string | null {
  if (!pr || typeof pr.number !== 'number') return null;
  const tag = pr.isDraft ? 'DRAFT' : pr.state;
  return `${dim('pr:')}${yellow(bold(`#${pr.number} ${tag}`))}`;
}
