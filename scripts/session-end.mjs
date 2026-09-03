#!/usr/bin/env node
import { readSessionEndFrame } from './lib/stdin.mjs';
import { isMainThread } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const fallback = { continue: true, suppressOutput: true };

export async function runSessionEndHook() {
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

if (!isMainThread || (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))) {
  void runSessionEndHook().finally(() => {
    if (!isMainThread) process.exit(0);
  });
}
