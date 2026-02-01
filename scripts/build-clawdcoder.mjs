#!/usr/bin/env node
/**
 * Build script for ClawdCoder bot bundle
 * Bundles the ClawdCoder bot into a standalone JS file
 */

import * as esbuild from 'esbuild';
import { mkdir } from 'fs/promises';

const outfile = 'bridge/clawdcoder.cjs';

// Ensure output directory exists
await mkdir('bridge', { recursive: true });

// Preamble: resolve global npm modules so externalized native packages
// can be found when running from plugin cache
const banner = `
// Resolve global npm modules for native package imports
try {
  var _cp = require('child_process');
  var _Module = require('module');
  var _globalRoot = _cp.execSync('npm root -g', { encoding: 'utf8', timeout: 5000 }).trim();
  if (_globalRoot) {
    process.env.NODE_PATH = _globalRoot + (process.env.NODE_PATH ? ':' + process.env.NODE_PATH : '');
    _Module._initPaths();
  }
} catch (_e) { /* npm not available - native modules will gracefully degrade */ }
`;

await esbuild.build({
  entryPoints: ['src/clawdcoder/index.ts'],
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
    'better-sqlite3',
    // Discord.js and grammy have native dependencies
    'discord.js',
    'grammy',
  ],
});

console.log(`Built ${outfile}`);
