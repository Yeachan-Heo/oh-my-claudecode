#!/usr/bin/env node

/**
 * PreCompact Hook: Project Memory Preservation
 * Ensures user directives and project context survive compaction
 */

import { processPreCompact } from '../dist/hooks/project-memory/pre-compact.js';

/**
 * Read JSON input from stdin
 */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Main hook execution
 */
async function main() {
  try {
    const input = await readStdin();
    const data = JSON.parse(input);

    // Process PreCompact
    const result = await processPreCompact(data);

    // Return result
    console.log(JSON.stringify(result));
  } catch (error) {
    // Always continue on error
    console.log(JSON.stringify({
      continue: true,
    }));
  }
}

main();
