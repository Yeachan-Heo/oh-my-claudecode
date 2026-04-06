#!/usr/bin/env node
import { readStdin } from './lib/stdin.mjs';

async function main() {
  const input = await readStdin(1000);
  try {
    const data = JSON.parse(input);
    const { onSessionStart } = await import('../dist/hooks/wiki/session-hooks.js');
    const result = onSessionStart(data);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error('[wiki-session-start] Error:', error.message);
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
}

main();
