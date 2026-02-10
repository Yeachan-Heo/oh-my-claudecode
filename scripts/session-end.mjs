#!/usr/bin/env node
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readStdin } from './lib/stdin.mjs';

async function main() {
  // Read stdin (timeout-protected, see issue #240/#459)
  const input = await readStdin();

  try {
    const data = JSON.parse(input);
    const { processSessionEnd } = await import('../dist/hooks/session-end/index.js');
    const result = await processSessionEnd(data);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error('[session-end] Error:', error.message);
    process.exit(0); // Don't block on errors
  }
}

main();
