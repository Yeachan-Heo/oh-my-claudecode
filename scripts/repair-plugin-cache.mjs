#!/usr/bin/env node
/**
 * Repair OMC plugin cache references after marketplace updates.
 *
 * Claude Code can keep a running session pointed at the previous plugin cache
 * path while /plugin marketplace update installs a newer cache directory.  The
 * setup wizard must not delete that old path before the plugin registry and
 * long-running-session fallback are repaired, or every hook/skill invocation
 * emits "Plugin directory does not exist" for the old version.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeHooksDataForPlatform } from './lib/hook-command-normalizer.mjs';

function getClaudeConfigDir() {
  const configured = (process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')).replace(/[\\/]+$/, '');
  if (configured === '~') return homedir();
  if (configured.startsWith('~/') || configured.startsWith('~\\')) return join(homedir(), configured.slice(2));
  return configured;
}

function parseVersion(version) {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/);
  return match ? match.slice(1, 4).map(Number) : null;
}

function compareVersionsDesc(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  for (let i = 0; i < 3; i += 1) {
    const delta = pb[i] - pa[i];
    if (delta !== 0) return delta;
  }
  return 0;
}

function isValidOmcPluginRoot(root) {
  return existsSync(join(root, 'hooks', 'hooks.json'))
    || existsSync(join(root, 'skills', 'omc-setup', 'SKILL.md'))
    || existsSync(join(root, 'docs', 'CLAUDE.md'));
}

function latestValidCacheRoot(cacheBase) {
  if (!existsSync(cacheBase)) return null;
  try {
    const versions = readdirSync(cacheBase, { withFileTypes: true })
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .map(entry => entry.name)
      .filter(name => parseVersion(name))
      .sort(compareVersionsDesc);

    for (const version of versions) {
      const root = join(cacheBase, version);
      if (isValidOmcPluginRoot(root)) return root;
    }
  } catch {
    return null;
  }
  return null;
}

function readJson(path) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf-8').trim();
  if (!raw) return null;
  return JSON.parse(raw);
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(tmp, path);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch {}
    throw error;
  }
}

function patchHooksJsonForPlatform(pluginRoot, platform = process.platform) {
  const hooksJsonPath = join(pluginRoot, 'hooks', 'hooks.json');
  if (!existsSync(hooksJsonPath)) return false;

  const data = readJson(hooksJsonPath);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;

  const patched = normalizeHooksDataForPlatform(data, platform);
  if (patched) writeJsonAtomic(hooksJsonPath, data);
  return patched;
}

function normalizePath(pathValue) {
  return String(pathValue).replace(/\\/g, '/').replace(/\/+$/, '');
}

function rewriteOmcRegistryEntries(installedPluginsPath, latestRoot) {
  const raw = readJson(installedPluginsPath);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { updated: false, entries: 0, stalePaths: [] };
  }

  const plugins = raw.plugins && typeof raw.plugins === 'object' && !Array.isArray(raw.plugins)
    ? raw.plugins
    : raw;
  const latestVersion = basename(latestRoot);
  let updated = false;
  let entries = 0;
  const stalePaths = [];

  for (const [pluginId, value] of Object.entries(plugins)) {
    if (!pluginId.toLowerCase().includes('oh-my-claudecode') || !Array.isArray(value)) continue;

    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue;
      entries += 1;
      const currentPath = typeof entry.installPath === 'string' ? entry.installPath : '';
      const currentVersion = typeof entry.version === 'string' ? entry.version : basename(currentPath);
      const currentExists = currentPath ? existsSync(currentPath) : false;
      const latestIsNewer = parseVersion(currentVersion) && compareVersionsDesc(latestVersion, currentVersion) < 0;

      if (!currentExists || latestIsNewer || normalizePath(currentPath) !== normalizePath(latestRoot)) {
        if (currentPath && normalizePath(currentPath) !== normalizePath(latestRoot)) {
          stalePaths.push(currentPath);
        }
        entry.installPath = latestRoot;
        entry.version = latestVersion;
        updated = true;
      }
    }
  }

  if (updated) {
    writeJsonAtomic(installedPluginsPath, raw);
  }

  return { updated, entries, stalePaths };
}

function replaceWithSymlink(versionPath, latestRoot) {
  const latestVersion = basename(latestRoot);
  if (basename(versionPath) === latestVersion) return false;

  try {
    const stat = lstatSync(versionPath);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(versionPath);
      if (target === latestVersion || normalizePath(target) === normalizePath(latestRoot)) return false;
    }
  } catch {
    mkdirSync(dirname(versionPath), { recursive: true });
    symlinkSync(process.platform === 'win32' ? latestRoot : latestVersion, versionPath, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  }

  rmSync(versionPath, { recursive: true, force: true });
  symlinkSync(process.platform === 'win32' ? latestRoot : latestVersion, versionPath, process.platform === 'win32' ? 'junction' : 'dir');
  return true;
}

export function repairPluginCacheReferences() {
  const configDir = getClaudeConfigDir();
  const cacheBase = join(configDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode');
  const latestRoot = latestValidCacheRoot(cacheBase);
  const result = { latestRoot, registryUpdated: false, hooksPatched: false, symlinked: 0, errors: [] };

  if (!latestRoot) return result;

  try {
    result.hooksPatched = patchHooksJsonForPlatform(latestRoot, process.env.OMC_REPAIR_PLUGIN_CACHE_PLATFORM || process.platform);
  } catch (error) {
    result.errors.push(`hooks.json platform repair failed: ${error instanceof Error ? error.message : error}`);
  }

  const installedPluginsPath = join(configDir, 'plugins', 'installed_plugins.json');
  try {
    const registry = rewriteOmcRegistryEntries(installedPluginsPath, latestRoot);
    result.registryUpdated = registry.updated;
    for (const stalePath of registry.stalePaths) {
      const staleParent = normalizePath(dirname(stalePath));
      if (staleParent === normalizePath(cacheBase) && parseVersion(basename(stalePath))) {
        try {
          if (replaceWithSymlink(stalePath, latestRoot)) result.symlinked += 1;
        } catch (error) {
          result.errors.push(`cache fallback repair failed for ${stalePath}: ${error instanceof Error ? error.message : error}`);
        }
      }
    }
  } catch (error) {
    result.errors.push(`installed_plugins.json repair failed: ${error instanceof Error ? error.message : error}`);
  }

  try {
    const latestVersion = basename(latestRoot);
    const versions = readdirSync(cacheBase, { withFileTypes: true })
      .filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) && parseVersion(entry.name))
      .map(entry => entry.name)
      .filter(version => version !== latestVersion)
      .sort(compareVersionsDesc);

    for (const version of versions) {
      try {
        if (replaceWithSymlink(join(cacheBase, version), latestRoot)) {
          result.symlinked += 1;
        }
      } catch (error) {
        result.errors.push(`cache fallback repair failed for ${version}: ${error instanceof Error ? error.message : error}`);
      }
    }
  } catch (error) {
    result.errors.push(`cache scan failed: ${error instanceof Error ? error.message : error}`);
  }

  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = repairPluginCacheReferences();
  for (const error of result.errors) {
    console.warn(`[OMC] Plugin cache repair warning: ${error}`);
  }
  if (!result.latestRoot) {
    console.log('[OMC] No OMC plugin cache found (normal for new installs)');
  } else if (result.registryUpdated || result.hooksPatched || result.symlinked > 0) {
    console.log(`[OMC] Repaired plugin cache references: active=${result.latestRoot}, symlinked=${result.symlinked}${result.hooksPatched ? ', hooks=platform' : ''}`);
  } else {
    console.log('[OMC] Plugin cache references are current');
  }
}
