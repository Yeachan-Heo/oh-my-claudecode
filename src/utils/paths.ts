/**
 * Cross-Platform Path Utilities
 *
 * Provides utility functions for handling paths across Windows, macOS, and Linux.
 * These utilities ensure paths in configuration files use forward slashes
 * (which work universally) and handle platform-specific directory conventions.
 */

import { join, dirname } from 'path';
import { existsSync, readFileSync, readdirSync, statSync, lstatSync, unlinkSync, rmSync, renameSync, symlinkSync } from 'fs';
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

/** Suffix for the directory a stale version is moved to while its redirect
 * symlink is placed. Includes the pid so concurrent purges cannot collide. */
const ASIDE_SUFFIX = '.omc-stale-';

/** Matches the aside suffix so an interrupted relink can be recognised and
 * repaired instead of being mistaken for a plugin version. Group 1 is the pid
 * of the purge that created it. */
const ASIDE_SUFFIX_RE = /\.omc-stale-(\d+)$/;

/**
 * What a plugin root has to expose for a pinned session to keep working.
 *
 * This mirrors `isPluginRoot()` in `scripts/run.cjs` — the hook runner's own
 * check — and must stay in step with it. The runner requires all of these, so a
 * root missing any one cannot run hooks no matter what else it holds. Note that
 * `.claude-plugin/plugin.json` is deliberately absent: the runner does not
 * consult it, so a manifest-only directory is not a usable root.
 */
const PLUGIN_ROOT_REQUIREMENTS = [
  join('hooks', 'hooks.json'),
  join('scripts', 'run.cjs'),
  'scripts',
];

/**
 * True when `path` can serve as a plugin root: a live redirect symlink, or a
 * directory that actually carries plugin payload.
 *
 * Presence is not enough, and neither is "holds a non-dotfile", and neither is
 * "holds one of the entry points". A directory left by a lost relink window can
 * hold `.DS_Store` (Finder writes it the moment it walks the path),
 * `desktop.ini`/`Thumbs.db` on Windows, a half-extracted `scripts/`, or a
 * partially copied root with only the manifest or only `hooks/hooks.json` — none
 * of which the hook runner will load. Treating any of those as usable is what
 * makes a recovery discard the only intact copy.
 *
 * A dangling symlink is not usable either: `existsSync` follows the link, so a
 * redirect whose target has since been removed is correctly rejected.
 */
function isUsableVersionPath(path: string): boolean {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    return false;
  }
  // A plain file at a version path is never a root; anything else gets the same
  // payload check.  `existsSync` follows symlinks, so one expression covers a
  // real directory, a redirect to a real root (usable), a redirect to some other
  // directory (not usable — the runner validates the resolved root), and a
  // dangling redirect (not usable).
  if (!stats.isDirectory() && !stats.isSymbolicLink()) return false;
  return PLUGIN_ROOT_REQUIREMENTS.every(required => existsSync(join(path, required)));
}

/**
 * True when the purge that created an aside directory is still running, i.e.
 * the backup belongs to a swap in flight and must not be touched.
 *
 * Signal 0 does not deliver anything; it only probes. `EPERM` means the process
 * exists but is not ours to signal, which still counts as alive.
 */
function isAsideOwnerAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Remove whatever occupies `path`, including a symlink whose target is gone.
 *
 * `safeRmSync` guards on `existsSync`, which follows the link — so a dangling
 * redirect reports false and is left in place, and every retry then fails the
 * same way. `lstatSync` sees the link itself.
 */
function removePathEntry(path: string): boolean {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    return false;
  }
  try {
    if (stats.isDirectory()) {
      rmSync(path, { recursive: true, force: true });
    } else {
      unlinkSync(path);
    }
    return true;
  } catch {
    return false;
  }
}

/** Errno values that mean "something else is at this path", per POSIX rename(2)
 * and symlink(2). Verified on macOS/APFS:
 *   symlink over any existing entry        → EEXIST
 *   rename(dir → non-empty dir)            → ENOTEMPTY
 *   rename(dir → symlink, live or dangling)→ ENOTDIR
 *   rename(dir → empty dir)                → succeeds
 *
 * Windows reports a collision as EPERM/EACCES rather than ENOTEMPTY, so those
 * are added there only. They stay out on POSIX, where they mean the caller
 * genuinely lacks permission and clearing the path would be the wrong response.
 * Retrying is still safe under either reading: removePathEntry() fails on a path
 * we cannot write, the attempts drain, and the caller reports instead of
 * silently dropping anything.
 */
const OCCUPIED_CODES = new Set(
  process.platform === 'win32'
    ? ['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR', 'EPERM', 'EACCES']
    : ['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR'],
);

/**
 * Run `place` at `path`, clearing whatever occupies it and retrying when the
 * path is taken. Returns false once the attempts are exhausted.
 *
 * Both halves of a relink need this: the symlink placement and the rollback
 * that restores the original directory. A rollback that is not retried can
 * leave the original stranded at its aside path while a squatter holds the
 * pinned path — the exact failure this helper exists to prevent.
 */
function placeClearingSquatters(
  path: string,
  place: () => void,
  /** Directory the path must sit directly inside. Clearing anything else — a
   * parent, a sibling namespace — would delete versions this operation has no
   * business touching, so the guard refuses rather than trusting the caller. */
  containedIn: string,
): { ok: true } | { ok: false; last: unknown } {
  if (stripTrailing(dirname(path)) !== stripTrailing(containedIn)) {
    return { ok: false, last: new Error(`refusing to clear ${path}: not a child of ${containedIn}`) };
  }
  let last: unknown;
  for (let attempt = 0; attempt < RELINK_ATTEMPTS; attempt++) {
    try {
      place();
      return { ok: true };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!code || !OCCUPIED_CODES.has(code)) throw err;
      last = err;
      removePathEntry(path);
    }
  }
  return { ok: false, last };
}

function describeError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code) return code;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Replace a stale version directory with a symlink to `target`, without ever
 * leaving the path missing.
 *
 * `rename()` cannot swap a directory for a symlink (POSIX requires both sides to
 * be the same type), so the stale directory is moved aside first and only
 * discarded once the symlink is in place. If the symlink cannot be created —
 * something re-created the path inside the window — the stale directory is moved
 * back, keeping `CLAUDE_PLUGIN_ROOT`-pinned sessions alive.
 *
 * Invariant: on return the path is either the redirect symlink or the original
 * directory. It is never an empty directory and never absent.
 */
function relinkStaleVersionDir(versionDir: string, target: string): void {
  const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
  const asideDir = `${versionDir}${ASIDE_SUFFIX}${process.pid}`;
  const pluginDir = dirname(versionDir);

  // Never overwrite an intact backup: it is the only copy of some version, and
  // clearing it here is how the earlier revision could destroy one. Aside
  // entries are reconciled before normal versions, so reaching this with a
  // usable backup in place means another purge owns it.
  if (isUsableVersionPath(asideDir)) {
    throw new Error(`an intact backup already occupies ${asideDir}`);
  }
  removePathEntry(asideDir);
  renameSync(versionDir, asideDir);

  let failure: unknown;
  try {
    const placed = placeClearingSquatters(versionDir, () => symlinkSync(target, versionDir, symlinkType), pluginDir);
    if (placed.ok) {
      safeRmSync(asideDir);
      return;
    }
    failure = new Error(
      `could not place redirect symlink after ${RELINK_ATTEMPTS} attempts (${describeError(placed.last)})`,
    );
  } catch (err) {
    // Not a contended path (EPERM, EACCES, …) — restore and report as-is.
    failure = err;
  }

  if (!placeClearingSquatters(versionDir, () => renameSync(asideDir, versionDir), pluginDir).ok) {
    throw new Error(
      `could not place redirect symlink (${describeError(failure)}) and could not restore the ` +
      `original: it is left at ${asideDir}`,
    );
  }
  throw failure;
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
  /** Number of version directories restored from an interrupted relink */
  restored: number;
  /** Version paths that were restored from an interrupted relink */
  restoredPaths: string[];
  /** Number of backups left in place because their owning purge is still running */
  skipped: number;
  /** Backup paths left to their live owner, with the version path they belong to */
  skippedPaths: string[];
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
  const result: PurgeCacheResult = {
    removed: 0, removedPaths: [], symlinked: 0, symlinkPaths: [],
    restored: 0, restoredPaths: [], skipped: 0, skippedPaths: [], errors: [],
  };

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

      // Reconcile interrupted relinks BEFORE walking normal versions.  Entries
      // arrive in filesystem order, so a squatter at `4.15.6` could otherwise be
      // relinked first — and that relink clears `4.15.6.omc-stale-<pid>`, the
      // only intact backup, before anyone knows the new symlink can be placed.
      const asideEntries: { versionDir: string; originalDir: string; ownerPid: number }[] = [];
      const plainVersions: string[] = [];
      for (const version of versions) {
        const aside = ASIDE_SUFFIX_RE.exec(version);
        // A bare `.omc-stale-<pid>` carries no version to restore to: the prefix
        // would be empty and the "original" path would resolve to the plugin
        // namespace itself.  Renaming the entry over its own parent reports
        // ENOTEMPTY, which the placement helper reads as an occupied path and
        // clears recursively — taking the active version and every sibling with
        // it.  An entry we cannot attribute is left alone, not acted on.
        if (aside && aside.index > 0) {
          asideEntries.push({
            versionDir: join(pluginDir, version),
            originalDir: join(pluginDir, version.slice(0, aside.index)),
            ownerPid: Number(aside[1]),
          });
        } else if (!aside) {
          plainVersions.push(version);
        }
      }

      for (const { versionDir, originalDir, ownerPid } of asideEntries) {
        // A live owner means the swap is in flight, not interrupted.  Stealing
        // its backup would make the owner's retry delete the real directory.
        //
        // Record it rather than returning silently: while the owner runs, the
        // version path is legitimately unusable, but if that pid was recycled by
        // an unrelated process the backup is never reclaimed and the pinned path
        // stays broken with nothing to show for it.
        if (isAsideOwnerAlive(ownerPid)) {
          result.skipped++;
          result.skippedPaths.push(`${versionDir} (owner pid ${ownerPid} still running)`);
          continue;
        }
        try {
          if (isUsableVersionPath(originalDir)) {
            // The redirect landed, or the version was reinstalled — the aside
            // copy carries nothing the live path does not already have.
            safeRmSync(versionDir);
          } else {
            // The path is missing, or holds only a squatter created inside the
            // lost window.  The aside copy is the sole intact version, so it
            // wins: clear the squatter and move it back, retrying if the
            // squatter comes back while we do.
            if (!placeClearingSquatters(originalDir, () => renameSync(versionDir, originalDir), pluginDir).ok) {
              throw new Error(`could not restore it over the path after ${RELINK_ATTEMPTS} attempts`);
            }
            result.restored++;
            result.restoredPaths.push(originalDir);
          }
        } catch (err) {
          result.errors.push(
            `Failed to reconcile interrupted relink ${versionDir}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      for (const version of plainVersions) {
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
          // No active sibling exists, so there is nothing to redirect to and a
          // symlink is not possible — deletion is the only cleanup path, and
          // keeping the directory forever was rejected in 9bfd910e ("would
          // accumulate real dirs indefinitely").  A session pinned here is
          // therefore protected only by the grace period, whose mtime signal
          // does not track liveness; that is tracked separately in #3688.
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
