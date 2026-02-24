/**
 * Cross-Platform Path Utilities
 *
 * Provides utility functions for handling paths across Windows, macOS, and Linux.
 * These utilities ensure paths in configuration files use forward slashes
 * (which work universally) and handle platform-specific directory conventions.
 */
import { join } from 'path';
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, rmSync } from 'fs';
import { homedir } from 'os';
import { getConfigDir as getClaudeBaseConfigDir } from './config-dir.js';
/**
 * Convert a path to use forward slashes (for JSON/config files)
 * This is necessary because settings.json commands are executed
 * by shells that expect forward slashes even on Windows
 */
export function toForwardSlash(path) {
    return path.replace(/\\/g, '/');
}
/**
 * Get Claude config directory path.
 * Respects the CLAUDE_CONFIG_DIR environment variable when set.
 */
export function getClaudeConfigDir() {
    return getClaudeBaseConfigDir();
}
/**
 * Get a path suitable for use in shell commands
 * Converts backslashes to forward slashes for cross-platform compatibility
 */
export function toShellPath(path) {
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
export function getDataDir() {
    if (process.platform === 'win32') {
        return process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    }
    return process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
}
/**
 * Get Windows-appropriate config directory
 */
export function getConfigDir() {
    if (process.platform === 'win32') {
        return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    }
    return process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
}
/**
 * Get the plugin cache base directory for oh-my-claudecode.
 * This is the directory containing version subdirectories.
 *
 * Structure: <configDir>/plugins/cache/omc/oh-my-claudecode/
 */
export function getPluginCacheBase() {
    return join(getClaudeConfigDir(), 'plugins', 'cache', 'omc', 'oh-my-claudecode');
}
/**
 * Safely delete a file, ignoring ENOENT errors.
 * Prevents crashes when cleaning up files that may not exist (Bug #13 fix).
 */
export function safeUnlinkSync(filePath) {
    try {
        if (existsSync(filePath)) {
            unlinkSync(filePath);
            return true;
        }
        return false;
    }
    catch {
        return false;
    }
}
/**
 * Safely remove a directory recursively, ignoring errors.
 */
export function safeRmSync(dirPath) {
    try {
        if (existsSync(dirPath)) {
            rmSync(dirPath, { recursive: true, force: true });
            return true;
        }
        return false;
    }
    catch {
        return false;
    }
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
function stripTrailing(p) {
    return toForwardSlash(p).replace(/\/+$/, '');
}
/** Default grace period: skip directories modified within the last 24 hours.
 * Extended from 1 hour to 24 hours to avoid deleting cache directories that
 * are still referenced by long-running sessions via CLAUDE_PLUGIN_ROOT. */
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
export function purgeStalePluginCacheVersions() {
    const result = { removed: 0, removedPaths: [], errors: [] };
    const configDir = getClaudeConfigDir();
    const pluginsDir = join(configDir, 'plugins');
    const installedFile = join(pluginsDir, 'installed_plugins.json');
    const cacheDir = join(pluginsDir, 'cache');
    if (!existsSync(installedFile) || !existsSync(cacheDir)) {
        return result;
    }
    // Collect active install paths (normalised, trailing-slash stripped)
    let activePaths;
    try {
        const raw = JSON.parse(readFileSync(installedFile, 'utf-8'));
        const plugins = raw.plugins ?? raw;
        if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins)) {
            result.errors.push('installed_plugins.json has unexpected top-level structure');
            return result;
        }
        activePaths = new Set();
        for (const entries of Object.values(plugins)) {
            if (!Array.isArray(entries))
                continue;
            for (const entry of entries) {
                const ip = entry.installPath;
                if (ip) {
                    activePaths.add(stripTrailing(ip));
                }
            }
        }
    }
    catch (err) {
        result.errors.push(`Failed to parse installed_plugins.json: ${err instanceof Error ? err.message : err}`);
        return result;
    }
    // Walk cache/<marketplace>/<plugin>/<version> and remove inactive versions
    let marketplaces;
    try {
        marketplaces = readdirSync(cacheDir, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);
    }
    catch {
        return result;
    }
    const now = Date.now();
    for (const marketplace of marketplaces) {
        const marketDir = join(cacheDir, marketplace);
        let pluginNames;
        try {
            pluginNames = readdirSync(marketDir, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => d.name);
        }
        catch {
            continue;
        }
        for (const pluginName of pluginNames) {
            const pluginDir = join(marketDir, pluginName);
            let versions;
            try {
                versions = readdirSync(pluginDir, { withFileTypes: true })
                    .filter(d => d.isDirectory())
                    .map(d => d.name);
            }
            catch {
                continue;
            }
            for (const version of versions) {
                const versionDir = join(pluginDir, version);
                const normalised = stripTrailing(versionDir);
                // Check if this version or any of its subdirectories are referenced
                const isActive = activePaths.has(normalised) ||
                    [...activePaths].some(ap => ap.startsWith(normalised + '/'));
                if (isActive)
                    continue;
                // Grace period: skip recently modified directories to avoid
                // race conditions during concurrent plugin updates
                try {
                    const stats = statSync(versionDir);
                    if (now - stats.mtimeMs < STALE_THRESHOLD_MS)
                        continue;
                }
                catch {
                    continue;
                }
                if (safeRmSync(versionDir)) {
                    result.removed++;
                    result.removedPaths.push(versionDir);
                }
            }
        }
    }
    return result;
}
//# sourceMappingURL=paths.js.map