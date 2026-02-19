#!/usr/bin/env node
/**
 * Build script for standalone Team Bridge entry point bundle
 * Bundles the bridge entry into a standalone JS file for plugin distribution
 */

import * as esbuild from 'esbuild';
import { mkdir } from 'fs/promises';

// Output to bridge/ directory (not gitignored) for plugin distribution
const outfile = 'bridge/team-bridge.cjs';

// Ensure output directory exists
await mkdir('bridge', { recursive: true });

// Preamble: resolve global npm modules so externalized native packages
// (like @ast-grep/napi) can be found when running from plugin cache
const banner = `
// Resolve global npm modules for native package imports
try {
  var _cp = require('child_process');
  var _Module = require('module');
  var _globalRoot = _cp.execSync('npm root -g', { encoding: 'utf8', timeout: 5000 }).trim();
  if (_globalRoot) {
    var _sep = process.platform === 'win32' ? ';' : ':';
    process.env.NODE_PATH = _globalRoot + (process.env.NODE_PATH ? _sep + process.env.NODE_PATH : '');
    _Module._initPaths();
  }
} catch (_e) { /* npm not available - native modules will gracefully degrade */ }
`;

await esbuild.build({
  entryPoints: ['src/team/bridge-entry.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile,
  banner: { js: banner },
  // Externalize Node.js built-ins and native modules
  external: [
    'fs', 'path', 'os', 'util', 'stream', 'events',
    'buffer', 'crypto', 'http', 'https', 'url',
    'child_process', 'assert', 'module', 'net', 'tls',
    'dns', 'readline', 'tty', 'worker_threads',
    // Native modules that can't be bundled
    '@ast-grep/napi',
    'better-sqlite3',
  ],
});

console.log(`Built ${outfile}`);
