#!/usr/bin/env node
import * as esbuild from 'esbuild';
import { mkdir } from 'fs/promises';

const outfile = 'bridge/cli.mjs';
await mkdir('bridge', { recursive: true });

await esbuild.build({
  entryPoints: ['src/cli/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile,
  // Note: shebang is preserved from entry file, no banner needed
  external: [
    'fs', 'fs/promises', 'path', 'os', 'util', 'stream', 'events',
    'buffer', 'crypto', 'http', 'https', 'url',
    'child_process', 'assert', 'module', 'net', 'tls',
    'dns', 'readline', 'tty', 'worker_threads',
    '@ast-grep/napi', 'better-sqlite3',
    // Avoid bundling jsonc-parser's UMD internals
    'jsonc-parser',
  ],
});
console.log(`Built ${outfile}`);
