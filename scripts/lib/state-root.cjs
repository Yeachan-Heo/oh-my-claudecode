// Thin delegator → src/lib/worktree-paths.ts::resolveSessionStatePaths. DO NOT reimplement here.

/**
 * State Root Resolver (CJS)
 *
 * Single authoritative entry point for resolving the .omc root directory in
 * CJS hook scripts, respecting the OMC_STATE_DIR environment variable.
 *
 * See scripts/lib/state-root.mjs for full documentation.
 */

'use strict';

const { join, basename, dirname, resolve } = require('path');
const { existsSync, readFileSync } = require('fs');
const { createHash } = require('crypto');
const { execFileSync } = require('child_process');
const { homedir } = require('os');

function findWorkspaceRoot(directory) {
  if (process.env.OMC_DISABLE_MULTIREPO === '1') return null;
  const home = resolve(homedir());
  let cursor = resolve(directory);
  while (true) {
    if (cursor === home) return null;
    if (existsSync(join(cursor, '.omc-workspace'))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

function workspaceIdentifier(workspaceRoot) {
  try {
    const config = JSON.parse(readFileSync(join(workspaceRoot, '.omc-workspace'), 'utf8'));
    if (typeof config.id === 'string' && config.id.trim()) {
      const safeId = config.id.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
      return `${safeId}-${createHash('sha256').update(safeId).digest('hex').slice(0, 16)}`;
    }
  } catch {}
  const hash = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 16);
  return `${basename(workspaceRoot).replace(/[^a-zA-Z0-9_-]/g, '_')}-${hash}`;
}

// git localizes its error messages; probeGitRoot() classifies "not a git
// repository" by matching the English stderr, so every spawn forces the C
// locale. Without it a non-English shell turns a benign non-git directory
// into a thrown error (#4033, mirrors the src/lib/worktree-paths.ts fix).
function gitEnv() { return { ...process.env, LC_ALL: 'C' }; }

function primaryGitRoot(gitRoot) {
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: gitRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 5000, env: gitEnv() }).trim();
    if (basename(commonDir) === '.git' && !commonDir.includes('/.git/modules/')) return dirname(commonDir);
  } catch {}
  return gitRoot;
}

function probeGitRoot(directory) {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 5000, env: gitEnv() }).trim() || null; }
  catch (error) { if (error?.code === 'ENOENT' || (error?.status === 128 && /not a git repository/i.test(String(error?.stderr ?? '')))) return null; throw error; }
}

function isSafeWorkspaceRoot(workspaceRoot) {
  const home = resolve(homedir());
  const normalized = workspaceRoot.replace(/\\/g, '/');
  let cursor = workspaceRoot;
  while (true) {
    const name = basename(cursor).toLowerCase();
    if (cursor === home || cursor === '/' || cursor === '/tmp' || name.startsWith('.') || ['.ssh', '.gnupg', '.aws', '.config', '.claude', '.codex', '.cache', '.npm', 'desktop', 'documents', 'downloads', 'pictures', 'music'].includes(name)) return false;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return normalized !== '';
}

/**
 * Resolve the .omc root directory, respecting OMC_STATE_DIR.
 *
 * @param {string} directory - Worktree root directory
 * @returns {Promise<string>} Absolute path to the .omc root
 */
async function resolveOmcStateRoot(directory) {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (pluginRoot) {
    const distPath = join(pluginRoot, 'dist', 'lib', 'worktree-paths.js');
    if (existsSync(distPath)) {
      const { pathToFileURL } = require('url');
      const { getOmcRoot } = await import(pathToFileURL(distPath).href);
      return getOmcRoot(directory);
    }
  }

  // Inline fallback: preserve the canonical non-git identity used by the
  // TypeScript resolver when the generated distribution is unavailable.
  const customDir = process.env.OMC_STATE_DIR;
  if (customDir) {
    const workspaceRoot = findWorkspaceRoot(directory);
    if (workspaceRoot) return join(customDir, workspaceIdentifier(workspaceRoot));
    const gitRoot = probeGitRoot(directory);
    if (!gitRoot) return join(customDir, 'non-git');
    const primaryRoot = primaryGitRoot(gitRoot);
    let source = primaryRoot;
    try { source = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: gitRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 5000, env: gitEnv() }).trim() || primaryRoot; } catch {}
    const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);
    return join(customDir, `${basename(primaryRoot).replace(/[^a-zA-Z0-9_-]/g, '_')}-${hash}`);
  }
  const workspaceRoot = findWorkspaceRoot(directory);
  if (workspaceRoot && isSafeWorkspaceRoot(workspaceRoot)) return join(workspaceRoot, '.omc');
  const gitRoot = probeGitRoot(directory);
  if (gitRoot) return join(gitRoot, '.omc');
  const home = resolve(homedir());
  return join(home, '.omc');
}

/**
 * Resolve session-scoped state paths for a given directory, state name, and session ID.
 * Delegates to resolveSessionStatePaths() in dist/lib/worktree-paths.js.
 *
 * @param {string} directory - Worktree root directory
 * @param {string} stateName - State name (e.g., "ralph", "ultrawork")
 * @param {string} [sessionId] - Optional session identifier
 * @returns {Promise<{readPath: string, writePath: string}>} Unbranded path pair
 */
async function resolveSessionStatePathsForHook(directory, stateName, sessionId) {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (pluginRoot) {
    try {
      const { pathToFileURL } = require('url');
      const { resolveSessionStatePaths } = await import(
        pathToFileURL(join(pluginRoot, 'dist', 'lib', 'worktree-paths.js')).href
      );
      const result = resolveSessionStatePaths(stateName, sessionId, directory);
      return { readPath: result.effectiveRead, writePath: result.effectiveWrite };
    } catch {
      // dist not built or unavailable — fall through to inline fallback
    }
  }

  // Inline fallback: basic session-scoped path derivation (production always uses dist above)
  const omcRoot = await resolveOmcStateRoot(directory);
  const normalizedName = stateName.endsWith('-state') ? stateName : `${stateName}-state`;
  const legacy = join(omcRoot, 'state', `${normalizedName}.json`);
  if (!sessionId) {
    return { readPath: legacy, writePath: legacy };
  }
  const sessionScoped = join(omcRoot, 'state', 'sessions', sessionId, `${normalizedName}.json`);
  // effectiveRead probes the session-scoped file first and falls back to the
  // legacy path when it does not exist yet (mirrors resolveSessionStatePaths).
  const readPath = existsSync(sessionScoped) ? sessionScoped : legacy;
  return { readPath, writePath: sessionScoped };
}

module.exports = { resolveOmcStateRoot, resolveSessionStatePathsForHook };
