#!/usr/bin/env node
/**
 * Build script for skill-bridge.cjs bundle
 * Bundles the TypeScript learner bridge module into a standalone CJS file
 * that skill-injector.mjs can require()
 */

import * as esbuild from 'esbuild';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';

const outfile = 'dist/hooks/skill-bridge.cjs';

// Ensure output directory exists
await mkdir(dirname(outfile), { recursive: true });

const watchMode = process.argv.includes('--watch');

const buildConfig = {
  entryPoints: ['src/hooks/learner/bridge.ts'],
  bundle: true,
  preserveSymlinks: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile,
  // Externalize Node.js built-ins (they're available at runtime)
  external: [
    'fs', 'path', 'os', 'util', 'stream', 'events',
    'buffer', 'crypto', 'http', 'https', 'url',
    'child_process', 'assert', 'module'
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
