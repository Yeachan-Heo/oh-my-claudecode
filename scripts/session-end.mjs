#!/usr/bin/env node
import { readSessionEndFrame } from './lib/stdin.mjs';

const fallback = { continue: true, suppressOutput: true };

async function main() {
  const frame = await readSessionEndFrame();

  if (frame.status !== 'ok') {
    console.log(JSON.stringify(fallback));
    return;
  }

  try {
    const { processSessionEnd } = await import('../dist/hooks/session-end/index.js');
    const result = await processSessionEnd(frame.value);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error('[session-end] Error:', error.message);
    console.log(JSON.stringify(fallback));
  }
}

main();
