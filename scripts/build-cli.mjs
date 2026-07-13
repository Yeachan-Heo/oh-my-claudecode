#!/usr/bin/env node
import * as esbuild from 'esbuild';
import { mkdir } from 'fs/promises';

const watchMode = process.argv.includes('--watch');
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

const cliConfig = {
  entryPoints: ['src/cli/index.ts'],
  bundle: true,
  preserveSymlinks: true,
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
};

const teamOutfile = 'bridge/team.js';
const teamConfig = {
  entryPoints: ['src/cli/team.ts'],
  bundle: true,
  preserveSymlinks: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: teamOutfile,
  external: sharedExternal,
};

if (watchMode) {
  const cliCtx = await esbuild.context(cliConfig);
  const teamCtx = await esbuild.context(teamConfig);
  await Promise.all([cliCtx.watch(), teamCtx.watch()]);
  console.error(`Watching ${outfile} and ${teamOutfile}...`);
} else {
  await esbuild.build(cliConfig);
  console.error(`Built ${outfile}`);
  await esbuild.build(teamConfig);
  console.error(`Built ${teamOutfile}`);
}
