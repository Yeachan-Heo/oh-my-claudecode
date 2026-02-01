#!/usr/bin/env node
import * as esbuild from 'esbuild';
import { mkdir } from 'fs/promises';

await mkdir('dist', { recursive: true });

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/index.js',
  banner: { js: '#!/usr/bin/env node' },
  external: ['better-sqlite3'],
});

console.log('✓ Built dist/index.js');
