#!/usr/bin/env node
// OMC Stop Continuation Hook (Simplified)
// Always allows stop - soft enforcement via message injection only.

import { readStdin } from './lib/stdin.mjs';

async function main() {
  // Consume stdin with timeout protection (required for hook protocol)
  await readStdin();
  // Always allow stop
  console.log(JSON.stringify({ continue: true }));
}

main();
