#!/usr/bin/env node
/**
 * Build script for standalone Codex MCP server bundle
 * Bundles the Codex MCP server into a standalone JS file for plugin distribution
 */

import * as esbuild from 'esbuild';
import { mkdir, readdir, readFile } from 'fs/promises';
import { basename, join } from 'path';

// Output to bridge/ directory (not gitignored) for plugin distribution
const outfile = 'bridge/codex-server.cjs';

// Scan agents/*.md at build time to embed roles and prompts in the bundle.
// This eliminates fragile runtime filesystem scanning from CJS bundles.
const agentFiles = (await readdir('agents')).filter(f => f.endsWith('.md')).sort();
const agentRoles = agentFiles.map(f => basename(f, '.md'));

// Read and strip frontmatter from each agent prompt
const agentPrompts = {};
for (const file of agentFiles) {
  const content = await readFile(join('agents', file), 'utf-8');
  const match = content.match(/^---[\s\S]*?---\s*([\s\S]*)$/);
  agentPrompts[basename(file, '.md')] = match ? match[1].trim() : content.trim();
}
console.log(`Embedding ${agentRoles.length} agent roles + prompts into ${outfile}`);

// Scan agents.codex/*.md at build time to embed Codex-specific prompts
const codexPrompts = {};
try {
  const codexFiles = (await readdir('agents.codex'))
    .filter(f => f.endsWith('.md') && f !== 'CONVERSION-GUIDE.md').sort();
  for (const file of codexFiles) {
    const content = await readFile(join('agents.codex', file), 'utf-8');
    const match = content.match(/^---[\s\S]*?---\s*([\s\S]*)$/);
    codexPrompts[basename(file, '.md')] = match ? match[1].trim() : content.trim();
  }
  console.log(`Embedding ${Object.keys(codexPrompts).length} Codex agent prompts`);
} catch { /* agents.codex/ not present - OK */ }

// Warn about agents missing Codex-specific prompts
for (const role of agentRoles) {
  if (!codexPrompts[role]) {
    console.warn(`WARNING: Agent '${role}' has no Codex-specific prompt in agents.codex/`);
  }
}

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
  entryPoints: ['src/mcp/codex-standalone-server.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile,
  banner: { js: banner },
  // Inject build-time constants: agent roles list and prompt contents
  define: {
    '__AGENT_ROLES__': JSON.stringify(agentRoles),
    '__AGENT_PROMPTS__': JSON.stringify(agentPrompts),
    '__AGENT_PROMPTS_CODEX__': JSON.stringify(codexPrompts),
  },
  // Prefer ESM entry points so UMD packages (e.g. jsonc-parser) get properly bundled
  mainFields: ['module', 'main'],
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
