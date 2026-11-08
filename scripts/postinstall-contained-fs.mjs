#!/usr/bin/env node
/**
 * Optional postinstall hook for contained-fs native module.
 * 
 * Follows the same platform constraints as build-contained-fs.mjs:
 * - darwin: always attempt to build
 * - linux: skip gracefully (not built by default)
 * - other: skip gracefully
 * 
 * Also skips in development environments (when .git exists).
 */

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Determine package root
const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, '..');

// Skip if we're in development (source repo has .git)
if (existsSync(resolve(packageRoot, '.git'))) {
  process.exit(0);
}

// Skip on non-darwin platforms (consistent with build script default)
if (process.platform !== 'darwin') {
  process.exit(0);
}

// Check if native binary already exists for darwin
const nativePath = `contained-fs-${process.platform}-${process.arch}.node`;
const nativeBinary = resolve(packageRoot, 'native', nativePath);
if (existsSync(nativeBinary)) {
  process.exit(0);
}

// Attempt to build the optional native module on darwin. A failed build must
// not fail `npm install`, but it must tell the user how to recover.
const buildScript = resolve(scriptDir, 'build-contained-fs.mjs');
const result = spawnSync(process.execPath, [buildScript, '--optional'], {
  stdio: ['ignore', 'ignore', 'pipe'],
  timeout: 120000,
});

if (!existsSync(nativeBinary)) {
  const detail = result.error?.message ?? result.stderr?.toString().trim().split('\n').pop() ?? '';
  console.warn(
    `[oh-my-claude-sisyphus] contained-fs native addon was not built${detail ? ` (${detail})` : ''}. ` +
    `omc team/graph commands need it: run \`node scripts/build-contained-fs.mjs\` from ${packageRoot} ` +
    '(requires Xcode Command Line Tools and Node headers).',
  );
}

process.exit(0);
