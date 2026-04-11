/**
 * Active plugin-root resolution.
 *
 * TypeScript port of `resolve_active_plugin_root()` from
 * scripts/setup-claude-md.sh:22-89. Handles a stale `CLAUDE_PLUGIN_ROOT`
 * that can occur when a session was started before a plugin update
 * (e.g. a 4.8.2 session invoking setup after upgrading to 4.9.0).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_CONFIG_DIR } from '../installer/index.js';

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Default plugin root used when no `scriptDir` override is provided.
 * Resolves to two directories up from this file — equivalent to the bash
 * `SCRIPT_PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"`:
 *   - dev  : `src/setup/plugin-root.ts` → repo root
 *   - dist : `dist/setup/plugin-root.js` → repo root
 */
const DEFAULT_SCRIPT_PLUGIN_ROOT: string = (() => {
  try {
    return dirname(dirname(fileURLToPath(import.meta.url)));
  } catch {
    return process.cwd();
  }
})();

function isValidPluginRoot(candidate: string): boolean {
  try {
    return existsSync(candidate) && existsSync(join(candidate, 'docs', 'CLAUDE.md'));
  } catch {
    return false;
  }
}

function listCacheVersions(base: string): string[] {
  try {
    return readdirSync(base).filter(name => SEMVER_PATTERN.test(name));
  } catch {
    return [];
  }
}

/**
 * Descending numeric-per-dotted-field semver comparison.
 * Mirrors `sort -t. -k1,1nr -k2,2nr -k3,3nr` from the bash reference.
 */
function compareVersionsDesc(a: string, b: string): number {
  const parse = (v: string): number[] => {
    const core = v.split(/[-+]/, 1)[0] ?? v;
    return core.split('.').map(n => parseInt(n, 10) || 0);
  };
  const aa = parse(a);
  const bb = parse(b);
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i++) {
    const av = aa[i] ?? 0;
    const bv = bb[i] ?? 0;
    if (av !== bv) return bv - av;
  }
  return 0;
}

function findLatestValidCacheVersion(cacheBase: string): string | null {
  const valid = listCacheVersions(cacheBase).filter(v =>
    isValidPluginRoot(join(cacheBase, v)),
  );
  valid.sort(compareVersionsDesc);
  return valid[0] ?? null;
}

function readActiveInstallPath(installedPluginsFile: string): string | null {
  if (!existsSync(installedPluginsFile)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(installedPluginsFile, 'utf-8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const maybeWrapped = (parsed as { plugins?: unknown }).plugins;
  const plugins = (typeof maybeWrapped === 'object' && maybeWrapped !== null)
    ? maybeWrapped
    : parsed;

  if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins)) {
    return null;
  }

  for (const [key, entries] of Object.entries(plugins as Record<string, unknown>)) {
    if (!key.startsWith('oh-my-claudecode')) continue;
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const first = entries[0] as { installPath?: unknown } | undefined;
    if (first && typeof first.installPath === 'string' && first.installPath.length > 0) {
      return first.installPath;
    }
  }
  return null;
}

export interface ResolveActivePluginRootOptions {
  /** Override `CLAUDE_CONFIG_DIR` (primarily for tests). */
  configDir?: string;
  /**
   * Override the last-resort plugin root. `dirname(scriptDir)` is also used as
   * the cache base for the stale-version check and the fallback sibling scan.
   */
  scriptDir?: string;
}

/**
 * Resolve the active OMC plugin root directory.
 *
 * 1. Read `<configDir>/plugins/installed_plugins.json`, find the
 *    `oh-my-claudecode*` entry, and read its `installPath`.
 * 2. If that install path is valid (exists and contains `docs/CLAUDE.md`):
 *    check `dirname(scriptDir)` for a newer valid semver cache entry and
 *    prefer it over the `installed_plugins.json` entry — the 4.8.2 → 4.9.0
 *    stale-cache upgrade guard.
 * 3. Otherwise scan sibling version directories of `scriptDir` and return
 *    the newest valid version.
 * 4. Last resort: return `scriptDir` itself.
 */
export function resolveActivePluginRoot(
  opts: ResolveActivePluginRootOptions = {},
): string {
  const configDir = opts.configDir ?? CLAUDE_CONFIG_DIR;
  const scriptPluginRoot = opts.scriptDir ?? DEFAULT_SCRIPT_PLUGIN_ROOT;
  const cacheBase = dirname(scriptPluginRoot);
  const installedPluginsFile = join(configDir, 'plugins', 'installed_plugins.json');

  const activePath = readActiveInstallPath(installedPluginsFile);
  if (activePath && isValidPluginRoot(activePath)) {
    if (existsSync(cacheBase)) {
      const activeVersion = basename(activePath);
      const latestCacheVersion = findLatestValidCacheVersion(cacheBase);
      if (latestCacheVersion && latestCacheVersion !== activeVersion) {
        // Filter active_version through the same semver regex the bash uses
        // (`grep -E '^[0-9]+\.[0-9]+\.[0-9]+'`). If it's not a semver, treat
        // the cache version as preferred.
        const activeIsSemver = SEMVER_PATTERN.test(activeVersion);
        const preferCache = !activeIsSemver
          || compareVersionsDesc(activeVersion, latestCacheVersion) > 0;
        if (preferCache) {
          return join(cacheBase, latestCacheVersion);
        }
      }
    }
    return activePath;
  }

  if (existsSync(cacheBase)) {
    const latest = findLatestValidCacheVersion(cacheBase);
    if (latest) {
      const candidate = join(cacheBase, latest);
      if (isValidPluginRoot(candidate)) return candidate;
    }
  }

  return scriptPluginRoot;
}
