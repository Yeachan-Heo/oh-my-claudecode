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
    const { processWikiSessionEnd } = await import('../dist/hooks/session-end/index.js');
    const result = await processWikiSessionEnd(frame.value);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error('[wiki-session-end] Error:', error.message);
    console.log(JSON.stringify(fallback));
  }
}

main();
