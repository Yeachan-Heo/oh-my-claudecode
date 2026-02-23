#!/usr/bin/env node
/**
 * Build script for the Team MCP server bundle.
 * Bundles src/mcp/team-server.ts into bridge/team-mcp.cjs for plugin distribution.
 */

import * as esbuild from 'esbuild';
import { mkdir } from 'fs/promises';

const outfile = 'bridge/team-mcp.cjs';
await mkdir('bridge', { recursive: true });

await esbuild.build({
  entryPoints: ['src/mcp/team-server.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile,
  external: [
    'fs', 'fs/promises', 'path', 'os', 'util', 'stream', 'events',
    'buffer', 'crypto', 'http', 'https', 'url',
    'child_process', 'assert', 'module', 'net', 'tls',
    'dns', 'readline', 'tty', 'worker_threads',
  ],
});

console.log(`Built ${outfile}`);
