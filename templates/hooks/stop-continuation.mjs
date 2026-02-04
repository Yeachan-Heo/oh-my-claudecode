#!/usr/bin/env node
// OMC Stop Continuation Hook (Simplified)
// Always allows stop - soft enforcement via message injection only.

// Consume stdin (required for hook protocol)
async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  // Always allow stop
  console.log(JSON.stringify({ continue: true }));
}

main();
