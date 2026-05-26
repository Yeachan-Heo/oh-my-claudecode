#!/usr/bin/env node
'use strict';
/**
 * OMC Cross-platform hook runner (run.cjs)
 *
 * Uses process.execPath (the Node binary already running this script) to spawn
 * the target .mjs hook. The shipped plugin manifest launches this runner directly with
 * `node ... run.cjs` so native Windows can spawn hooks without /bin/sh.
 * Once Node has launched this runner, process.execPath is used for the
 * hook-script handoff.
 * Fixes issues #909, #899, #892, #869.
 *
 * Manifest usage (from hooks.json):
 *   node "${CLAUDE_PLUGIN_ROOT}/scripts/run.cjs" \
 *       "${CLAUDE_PLUGIN_ROOT}/scripts/<hook>.mjs" [args...]
 */

const { spawnSync } = require('child_process');
const { existsSync, readFileSync, realpathSync } = require('fs');
const { join, basename, dirname } = require('path');

const target = process.argv[2];
if (!target) {
  // Nothing to run — exit cleanly so Claude Code hooks are never blocked.
  process.exit(0);
}

/**
 * Resolve the hook script target path, handling stale CLAUDE_PLUGIN_ROOT.
 *
 * When a plugin update replaces an old version directory with a symlink (or
 * deletes it entirely), sessions that still reference the old version via
 * CLAUDE_PLUGIN_ROOT will fail with MODULE_NOT_FOUND.
 *
 * Resolution strategy:
 *   1. Use the target as-is if it exists.
 *   2. Try resolving through realpathSync (follows symlinks).
 *   3. Scan the plugin cache for the latest available version that has the
 *      same script name and use that instead.
 *   4. If all else fails, return null (caller exits cleanly).
 *
 * See: https://github.com/Yeachan-Heo/oh-my-claudecode/issues/1007
 */
function resolveTarget(targetPath) {
  // Fast path: target exists (common case)
  if (existsSync(targetPath)) return targetPath;

  // Try realpath resolution (handles broken symlinks that resolve elsewhere)
  try {
    const resolved = realpathSync(targetPath);
    if (existsSync(resolved)) return resolved;
  } catch {
    // realpathSync throws if the path doesn't exist at all — expected
  }

  // Fallback: scan plugin cache for the same script in the latest version.
  // CLAUDE_PLUGIN_ROOT is e.g. ~/.claude/plugins/cache/omc/oh-my-claudecode/4.2.14
  // We look one level up for sibling version directories.
  try {
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    if (!pluginRoot) return null;

    const cacheBase = dirname(pluginRoot);          // .../oh-my-claudecode/
    const scriptRelative = targetPath.slice(pluginRoot.length); // /scripts/persistent-mode.cjs

    if (!scriptRelative || !existsSync(cacheBase)) return null;

    // Find version directories (real dirs or valid symlinks), pick latest
    const { readdirSync, lstatSync, readlinkSync } = require('fs');
    const entries = readdirSync(cacheBase).filter(v => /^\d+\.\d+\.\d+/.test(v));

    // Sort descending by semver
    entries.sort((a, b) => {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
      }
      return 0;
    });

    for (const version of entries) {
      const candidate = join(cacheBase, version) + scriptRelative;
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // Any error in fallback scan — give up gracefully
  }

  return null;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function flattenHookEntries(rawHooks) {
  if (!rawHooks || typeof rawHooks !== 'object') return [];
  return Object.values(rawHooks).flatMap((entries) => Array.isArray(entries) ? entries : []);
}

function resolveHookTimeoutMs(targetPath, extraArgs) {
  const pluginRoot = dirname(dirname(targetPath));
  const hooksJsonPath = join(pluginRoot, 'hooks', 'hooks.json');
  if (!existsSync(hooksJsonPath)) return null;

  try {
    const hooksJson = JSON.parse(readFileSync(hooksJsonPath, 'utf-8'));
    const scriptName = basename(targetPath);
    const scriptPattern = new RegExp(`[/\\\\]scripts[/\\\\]${escapeRegex(scriptName)}(?:\\s|$)`);
    const argNeedles = extraArgs.filter((arg) => typeof arg === 'string' && arg.length > 0);

    for (const entry of flattenHookEntries(hooksJson?.hooks)) {
      const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
      for (const hook of hooks) {
        const command = typeof hook?.command === 'string' ? hook.command : '';
        const timeout = Number(hook?.timeout);
        if (!scriptPattern.test(command)) continue;
        if (!Number.isFinite(timeout) || timeout <= 0) continue;
        if (!argNeedles.every((arg) => command.includes(` ${arg}`) || command.endsWith(` ${arg}`))) continue;
        return Math.floor(timeout * 1000);
      }
    }
  } catch {
    return null;
  }

  return null;
}

const resolved = resolveTarget(target);
if (!resolved) {
  // Target not found anywhere — exit cleanly so hooks are never blocked.
  // This is the graceful fallback for stale CLAUDE_PLUGIN_ROOT paths.
  process.exit(0);
}

const timeoutMs = resolveHookTimeoutMs(resolved, process.argv.slice(3));

const result = spawnSync(
  process.execPath,
  [resolved, ...process.argv.slice(3)],
  {
    stdio: 'inherit',
    env: process.env,
    windowsHide: true,
    ...(timeoutMs ? {
      timeout: timeoutMs,
      killSignal: process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL',
    } : {}),
  }
);

if (result.error?.code === 'ETIMEDOUT' && timeoutMs) {
  process.stderr.write(`[run.cjs] Hook ${basename(resolved)} timed out after ${timeoutMs}ms; exiting fail-open.\n`);
}

// Propagate the child exit code (null → 0 to avoid blocking hooks).
process.exit(result.status ?? 0);
