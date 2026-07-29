#!/usr/bin/env node
import { readSessionEndFrame } from './lib/stdin.mjs';
import { isMainThread } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const fallback = { continue: true, suppressOutput: true };

export async function runWikiSessionEndHook() {
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

if (!isMainThread || (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))) void runWikiSessionEndHook();
