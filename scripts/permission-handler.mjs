#!/usr/bin/env node
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readStdin } from './lib/stdin.mjs';

async function main() {
  // Read stdin (timeout-protected, see issue #240/#459)
  const input = await readStdin();

  try {
    const data = JSON.parse(input);
    const { processPermissionRequest } = await import('../dist/hooks/permission-handler/index.js');
    const result = await processPermissionRequest(data);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error('[permission-handler] Error:', error.message);
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
}

main();
