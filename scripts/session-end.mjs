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
    const { publishSessionEndBootstrap } = await import('../dist/hooks/session-end/foreground-bootstrap.js');
    console.log(JSON.stringify(await publishSessionEndBootstrap(frame.value)));
  } catch {
    console.log(JSON.stringify(fallback));
  }
}

if (!isMainThread || (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))) void runSessionEndHook();
