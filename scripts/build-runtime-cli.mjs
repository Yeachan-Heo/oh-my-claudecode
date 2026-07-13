#!/usr/bin/env node
import * as esbuild from 'esbuild';
import { mkdir } from 'fs/promises';

const outfile = 'bridge/runtime-cli.cjs';
await mkdir('bridge', { recursive: true });

const watchMode = process.argv.includes('--watch');

const buildConfig = {
  entryPoints: ['src/team/runtime-cli.ts'],
  bundle: true,
  preserveSymlinks: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile,
  // Note: platform:'node' auto-externalizes all Node built-in subpaths (fs/promises, etc.)
  external: [
    'fs', 'fs/promises', 'path', 'os', 'util', 'stream', 'events',
    'buffer', 'crypto', 'http', 'https', 'url',
    'child_process', 'assert', 'module', 'net', 'tls',
    'dns', 'readline', 'tty', 'worker_threads',
    '@ast-grep/napi', 'better-sqlite3',
    // jsonc-parser has dynamic requires that don't bundle well; we use a custom parser
    'jsonc-parser',
  ],
};

if (watchMode) {
  const ctx = await esbuild.context(buildConfig);
  await ctx.watch();
  console.error(`Watching ${outfile}...`);
} else {
  await esbuild.build(buildConfig);
  console.error(`Built ${outfile}`);
}
