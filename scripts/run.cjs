#!/usr/bin/env node
'use strict';
/**
 * OMC Cross-platform hook runner (run.cjs)
 *
 * Uses process.execPath (the Node binary already running this script) to spawn
 * the target .mjs hook, bypassing PATH / shell discovery issues.
 *
 * Replaces the `sh + find-node.sh` chain that fails on Windows because
 * /usr/bin/sh is a PE32+ binary the OS refuses to execute natively.
 * Fixes issues #909, #899, #892, #869.
 *
 * Usage (from hooks.json, after setup patches the absolute node path in):
 *   /abs/path/to/node "${CLAUDE_PLUGIN_ROOT}/scripts/run.cjs" \
 *       "${CLAUDE_PLUGIN_ROOT}/scripts/<hook>.mjs" [args...]
 *
 * During post-install setup, the leading `node` token is replaced with
 * process.execPath so nvm/fnm users and Windows users all get the right binary.
 */

const { spawnSync } = require('child_process');

const target = process.argv[2];
if (!target) {
  // Nothing to run — exit cleanly so Claude Code hooks are never blocked.
  process.exit(0);
}

const result = spawnSync(
  process.execPath,
  [target, ...process.argv.slice(3)],
  {
    stdio: 'inherit',
    env: process.env,
    windowsHide: true,
  }
);

// Propagate the child exit code (null → 0 to avoid blocking hooks).
process.exit(result.status ?? 0);
