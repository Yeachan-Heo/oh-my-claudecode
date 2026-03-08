#!/usr/bin/env node
import * as esbuild from 'esbuild';
import { mkdir } from 'fs/promises';

const outfile = 'bridge/cli.cjs';
await mkdir('bridge', { recursive: true });

const sharedExternal = [
  'fs', 'fs/promises', 'path', 'os', 'util', 'stream', 'events',
  'buffer', 'crypto', 'http', 'https', 'url',
  'child_process', 'assert', 'module', 'net', 'tls',
  'dns', 'readline', 'tty', 'worker_threads',
  '@ast-grep/napi', 'better-sqlite3',
  // Avoid bundling jsonc-parser's UMD internals
  'jsonc-parser',
];

await esbuild.build({
  entryPoints: ['src/cli/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile,
  // Inject import.meta.url polyfill for CJS format
  banner: {
    js: 'const importMetaUrl = require("url").pathToFileURL(__filename);',
  },
  define: {
    'import.meta.url': 'importMetaUrl',
  },
  external: sharedExternal,
});
console.log(`Built ${outfile}`);

// Build team CLI module separately (dynamically imported by cli.cjs)
const teamOutfile = 'bridge/team.js';
await esbuild.build({
  entryPoints: ['src/cli/team.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: teamOutfile,
  external: sharedExternal,
});
console.log(`Built ${teamOutfile}`);
