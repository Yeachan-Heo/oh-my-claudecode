/**
 * Cross-Platform Path Utilities
 *
 * Provides utility functions for handling paths across Windows, macOS, and Linux.
 * These utilities ensure paths in configuration files use forward slashes
 * (which work universally) and handle platform-specific directory conventions.
 */

import { join } from 'path';
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, rmSync, renameSync, symlinkSync } from 'fs';
import { homedir } from 'os';
import { getClaudeConfigDir } from './config-dir.js';

/**
 * Convert a path to use forward slashes (for JSON/config files)
 * This is necessary because settings.json commands are executed
 * by shells that expect forward slashes even on Windows
 */
export function toForwardSlash(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * Get a path suitable for use in shell commands
 * Converts backslashes to forward slashes for cross-platform compatibility
 */
export function toShellPath(path: string): string {
  const normalized = toForwardSlash(path);
  // Windows paths with spaces need quoting
  if (normalized.includes(' ')) {
    return `"${normalized}"`;
  }
  return normalized;
}

/**
 * Get Windows-appropriate data directory
 * Falls back to sensible locations instead of XDG paths
 */
export function getDataDir(): string {
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  }
  return process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
}

/**
 * Get Windows-appropriate config directory
 */
export function getConfigDir(): string {
  if (process.platform === 'win32') {
    return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  }
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
}

/**
 * Get Windows-appropriate state directory.
 */
export function getStateDir(): string {
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  }

  return process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
}

function prefersXdgOmcDirs(): boolean {
  return process.platform !== 'win32' && process.platform !== 'darwin';
}

function getUserHomeDir(): string {
  if (process.platform === 'win32') {
    return process.env.USERPROFILE || process.env.HOME || homedir();
  }

  return process.env.HOME || homedir();
}

/**
 * Legacy global OMC directory under the user's home directory.
 */
export function getLegacyOmcDir(): string {
  return join(getUserHomeDir(), '.omc');
}

/**
 * Global OMC config directory.
 *
 * Precedence:
 * 1. OMC_HOME (existing explicit override)
 * 2. XDG-aware config root on Linux/Unix
 * 3. Legacy ~/.omc elsewhere
 */
export function getGlobalOmcConfigRoot(): string {
  const explicitRoot = process.env.OMC_HOME?.trim();
  if (explicitRoot) {
    return explicitRoot;
  }

  if (prefersXdgOmcDirs()) {
    return join(getConfigDir(), 'omc');
  }

  return getLegacyOmcDir();
}

/**
 * Global OMC state directory.
 *
 * When OMC_HOME is set, preserve that existing override semantics by treating
 * it as the shared root and resolving state beneath it.
 */
export function getGlobalOmcStateRoot(): string {
  const explicitRoot = process.env.OMC_HOME?.trim();
  if (explicitRoot) {
    return join(explicitRoot, 'state');
  }

  if (prefersXdgOmcDirs()) {
    return join(getStateDir(), 'omc');
  }

  return join(getLegacyOmcDir(), 'state');
}

export function getGlobalOmcConfigPath(...segments: string[]): string {
  return join(getGlobalOmcConfigRoot(), ...segments);
}

export function getGlobalOmcStatePath(...segments: string[]): string {
  return join(getGlobalOmcStateRoot(), ...segments);
}

export function getLegacyOmcPath(...segments: string[]): string {
  return join(getLegacyOmcDir(), ...segments);
}

function dedupePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

export function getGlobalOmcConfigCandidates(...segments: string[]): string[] {
  if (process.env.OMC_HOME?.trim()) {
    return [getGlobalOmcConfigPath(...segments)];
  }

  return dedupePaths([
    getGlobalOmcConfigPath(...segments),
    getLegacyOmcPath(...segments),
  ]);
}

export function getGlobalOmcStateCandidates(...segments: string[]): string[] {
  const explicitRoot = process.env.OMC_HOME?.trim();
  if (explicitRoot) {
    return dedupePaths([
      getGlobalOmcStatePath(...segments),
      join(explicitRoot, ...segments),
    ]);
  }

  return dedupePaths([
    getGlobalOmcStatePath(...segments),
    getLegacyOmcPath('state', ...segments),
  ]);
}

/**
 * Get the plugin cache base directory for oh-my-claudecode.
 * This is the directory containing version subdirectories.
 *
 * Structure: <configDir>/plugins/cache/omc/oh-my-claudecode/
 */
export function getPluginCacheBase(): string {
  return join(getClaudeConfigDir(), 'plugins', 'cache', 'omc', 'oh-my-claudecode');
}

/**
 * Safely delete a file, ignoring ENOENT errors.
 * Prevents crashes when cleaning up files that may not exist (Bug #13 fix).
 */
export function safeUnlinkSync(filePath: string): boolean {
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Safely remove a directory recursively, ignoring errors.
 */
export function safeRmSync(dirPath: string): boolean {
  try {
    if (existsSync(dirPath)) {
      rmSync(dirPath, { recursive: true, force: true });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** How many times to retry placing the redirect symlink when the path is
 * re-created underneath us (Finder `.DS_Store`, Spotlight, a concurrent
 * purge from another session). */
const RELINK_ATTEMPTS = 3;

/**
 * Replace a stale version directory with a symlink to `target`, without ever
 * leaving the path missing.
 *
 * `rename()` cannot swap a directory for a symlink (POSIX requires both sides
 * to be the same type), so the stale directory is moved aside first and only
 * discarded once the symlink is in place. If the symlink cannot be created —
 * something re-created the path inside the window — the stale directory is
 * restored, keeping `CLAUDE_PLUGIN_ROOT` pinned sessions alive.
 *
 * Invariant: on return the path is either the redirect symlink or the original
 * directory. It is never an empty directory and never absent.
 */
function relinkStaleVersionDir(versionDir: string, target: string): void {
  const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
  const asideDir = `${versionDir}.omc-stale-${process.pid}`;

  safeRmSync(asideDir);
  renameSync(versionDir, asideDir);

  for (let attempt = 0; attempt < RELINK_ATTEMPTS; attempt++) {
    try {
      symlinkSync(target, versionDir, symlinkType);
      safeRmSync(asideDir);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        safeRmSync(versionDir);
        renameSync(asideDir, versionDir);
        throw err;
      }
      // Something occupied the path; clear it and retry.
      safeRmSync(versionDir);
    }
  }

  safeRmSync(versionDir);
  renameSync(asideDir, versionDir);
  throw new Error(`could not place redirect symlink after ${RELINK_ATTEMPTS} attempts`);
}

/**
 * Result of a plugin cache purge operation.
 */
export interface PurgeCacheResult {
  /** Number of stale version directories removed */
  removed: number;
  /** Paths that were removed */
  removedPaths: string[];
  /** Number of stale version directories replaced with symlinks to the active version */
  symlinked: number;
  /** Paths that were converted to symlinks */
  symlinkPaths: string[];
  /** Errors encountered (non-fatal) */
  errors: string[];
}

/**
 * Purge stale plugin cache versions that are no longer referenced by
 * installed_plugins.json.
 *
 * Claude Code caches each plugin version under:
 *   <configDir>/plugins/cache/<marketplace>/<plugin>/<version>/
 *
 * On plugin update the old version directory is left behind. This function
 * reads the active install paths from installed_plugins.json and removes
 * every version directory that is NOT active.
 */
/**
 * Strip trailing slashes from a normalised forward-slash path.
 */
function stripTrailing(p: string): string {
  return toForwardSlash(p).replace(/\/+$/, '');
}

/** Default grace period: skip directories modified within the last 24 hours.
 * Extended from 1 hour to 24 hours to avoid deleting cache directories that
 * are still referenced by long-running sessions via CLAUDE_PLUGIN_ROOT. */
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * Compare two semver-like version strings descending (higher version first).
 * Non-numeric segments fall back to 0.
 */
function compareSemverDesc(a: string, b: string): number {
  const parse = (s: string) => s.split('.').map(n => parseInt(n, 10) || 0);
  const pa = parse(a), pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function purgeStalePluginCacheVersions(options?: { skipGracePeriod?: boolean }): PurgeCacheResult {
  const result: PurgeCacheResult = { removed: 0, removedPaths: [], symlinked: 0, symlinkPaths: [], errors: [] };

  const configDir = getClaudeConfigDir();
  const pluginsDir = join(configDir, 'plugins');
  const installedFile = join(pluginsDir, 'installed_plugins.json');
  const cacheDir = join(pluginsDir, 'cache');

  if (!existsSync(installedFile) || !existsSync(cacheDir)) {
    return result;
  }

  // Collect active install paths (normalised, trailing-slash stripped)
  let activePaths: Set<string>;
  try {
    const raw = JSON.parse(readFileSync(installedFile, 'utf-8'));
    const plugins = raw.plugins ?? raw;
    if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins)) {
      result.errors.push('installed_plugins.json has unexpected top-level structure');
      return result;
    }
    activePaths = new Set<string>();
    for (const entries of Object.values(plugins as Record<string, unknown>)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const ip = (entry as { installPath?: string }).installPath;
        if (ip) {
          activePaths.add(stripTrailing(ip));
        }
      }
    }
  } catch (err) {
    result.errors.push(`Failed to parse installed_plugins.json: ${err instanceof Error ? err.message : err}`);
    return result;
  }

  // Walk cache/<marketplace>/<plugin>/<version> and remove inactive versions
  let marketplaces: string[];
  try {
    marketplaces = readdirSync(cacheDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return result;
  }

  const now = Date.now();
  const activePathsArray = [...activePaths];

  for (const marketplace of marketplaces) {
    const marketDir = join(cacheDir, marketplace);
    let pluginNames: string[];
    try {
      pluginNames = readdirSync(marketDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch { continue; }

    for (const pluginName of pluginNames) {
      const pluginDir = join(marketDir, pluginName);
      let versions: string[];
      try {
        versions = readdirSync(pluginDir, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);
      } catch { continue; }

      for (const version of versions) {
        const versionDir = join(pluginDir, version);
        const normalised = stripTrailing(versionDir);

        // Check if this version or any of its subdirectories are referenced
        const isActive = activePaths.has(normalised) ||
          activePathsArray.some(ap => ap.startsWith(normalised + '/'));

        if (isActive) continue;

        // Grace period: skip recently modified directories to avoid
        // race conditions during concurrent plugin updates
        if (!options?.skipGracePeriod) {
          try {
            const stats = statSync(versionDir);
            if (now - stats.mtimeMs < STALE_THRESHOLD_MS) continue;
          } catch { continue; }
        }

        // When an active version exists in the same plugin namespace, replace the
        // stale directory with a symlink rather than deleting it.  This keeps any
        // running session whose CLAUDE_PLUGIN_ROOT still points to this path working.
        const pluginDirNorm = stripTrailing(pluginDir);
        const activeVersionDirsHere = dedupePaths(
          activePathsArray
            .filter(ap => ap.startsWith(pluginDirNorm + '/'))
            .map(ap => join(pluginDir, ap.slice(pluginDirNorm.length + 1).split('/')[0])),
        );

        if (activeVersionDirsHere.length > 0) {
          const target = [...activeVersionDirsHere].sort((a, b) =>
            compareSemverDesc(
              a.split('/').pop() ?? a,
              b.split('/').pop() ?? b,
            ),
          )[0];
          try {
            relinkStaleVersionDir(versionDir, target);
            result.symlinked++;
            result.symlinkPaths.push(versionDir);
          } catch (err) {
            result.errors.push(
              `Failed to symlink ${versionDir} → ${target}: ${err instanceof Error ? err.message : err}`,
            );
          }
        } else {
          if (safeRmSync(versionDir)) {
            result.removed++;
            result.removedPaths.push(versionDir);
          }
        }
      }
    }
  }

  return result;
}
