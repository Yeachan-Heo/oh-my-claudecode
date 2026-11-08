#!/usr/bin/env node
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Build-time only. Runtime never invokes a compiler or downloads a binary.

// Original behavior: darwin only, unless --optional or --force is passed
const isOptional = process.argv.includes('--optional');
const isForceBuild = process.argv.includes('--force');

// Skip on non-darwin platforms unless explicitly forced or optional
if (process.platform !== 'darwin' && !isForceBuild && !isOptional) {
  process.exit(0);
}

// Fail loudly if platform is unsupported AND not optional
if (!['darwin', 'linux'].includes(process.platform)) {
  if (isOptional) {
    process.exit(0);
  }
  throw new Error('Unsupported native build platform');
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const explicit = process.argv.find(arg => arg.startsWith('--headers='))?.slice('--headers='.length);
const version = process.versions.node;
const candidates = [
  explicit,
  process.env.npm_config_nodedir && join(process.env.npm_config_nodedir, 'include', 'node'),
  process.env.npm_config_nodedir && join(process.env.npm_config_nodedir, 'src'),
  join(homedir(), 'Library', 'Caches', 'node-gyp', version, 'include', 'node'),
  join(homedir(), '.cache', 'node-gyp', version, 'include', 'node'),
  '/usr/local/include/node',
  '/usr/include/node',
].filter(Boolean);

const headers = candidates.find(path => existsSync(join(path, 'node_api.h')));
if (!headers) {
  if (isOptional) {
    // Graceful skip for optional builds
    process.exit(0);
  }
  throw new Error('Node development headers are required. Supply --headers=/absolute/path/to/include/node (node_api.h), or populate the node-gyp cache before building. No headers are downloaded by this script.');
}

for (const arch of process.platform === 'darwin' ? ['arm64', 'x64'] : [process.arch]) {
  const output = join(root, 'native', `contained-fs-${process.platform}-${arch}.node`);
  mkdirSync(dirname(output), { recursive: true });
  const args = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-fPIC', '-I', headers];
  if (process.platform === 'darwin') args.push('-arch', arch === 'x64' ? 'x86_64' : arch, '-mmacosx-version-min=11.0', '-bundle', '-undefined', 'dynamic_lookup');
  else args.push('-shared');
  args.push(join(root, 'native', 'contained-fs.c'), '-o', output);
  const result = spawnSync(process.platform === 'darwin' ? 'clang' : 'cc', args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.log(`Built ${output}`);
}
