/**
 * State Root Resolver (CJS)
 *
 * Single authoritative entry point for resolving the .omc root directory in
 * CJS hook scripts, respecting the OMC_STATE_DIR environment variable.
 *
 * See scripts/lib/state-root.mjs for full documentation.
 */

'use strict';

const { join, basename } = require('path');
const { createHash } = require('crypto');

/**
 * Resolve the .omc root directory, respecting OMC_STATE_DIR.
 *
 * @param {string} directory - Worktree root directory
 * @returns {Promise<string>} Absolute path to the .omc root
 */
async function resolveOmcStateRoot(directory) {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (pluginRoot) {
    try {
      const { pathToFileURL } = require('url');
      const { getOmcRoot } = await import(
        pathToFileURL(join(pluginRoot, 'dist', 'lib', 'worktree-paths.js')).href
      );
      return getOmcRoot(directory);
    } catch {
      // dist not built or unavailable — fall through to inline fallback
    }
  }

  // Inline fallback: respects OMC_STATE_DIR with simplified project identifier
  const customDir = process.env.OMC_STATE_DIR;
  if (customDir) {
    const hash = createHash('sha256').update(directory).digest('hex').slice(0, 16);
    const dirName = basename(directory).replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(customDir, `${dirName}-${hash}`);
  }
  return join(directory, '.omc');
}

module.exports = { resolveOmcStateRoot };
