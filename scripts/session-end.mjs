#!/usr/bin/env node
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readStdin } from './lib/stdin.mjs';

async function main() {
  // Read stdin with reduced timeout for SessionEnd — the input payload is small
  // and doesn't need the default 5s wait. This saves ~4s toward the hook timeout (#1700).
  const input = await readStdin(1000);

  const fallback = { continue: true, suppressOutput: true };

  if (input.trim().length === 0) {
    console.log(JSON.stringify(fallback));
    return;
  }

  try {
    const data = JSON.parse(input);
    const { processSessionEnd } = await import('../dist/hooks/session-end/index.js');
    const result = await processSessionEnd(data);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error('[session-end] Error:', error.message);
    console.log(JSON.stringify(fallback));
  }
}

main();
