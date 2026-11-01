#!/usr/bin/env node
// OMC Stop Continuation Hook (Simplified)
// Always allows stop - soft enforcement via message injection only.

import { hardenWindowsExeSearch } from './lib/windows-search.mjs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

hardenWindowsExeSearch();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { readStdin } = await import(pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href);

async function main() {
  // Consume stdin with timeout protection (required for hook protocol)
  await readStdin();
  // Always allow stop
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

main();
