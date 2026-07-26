#!/usr/bin/env node

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SAFE_CONTINUE = { continue: true, suppressOutput: true };

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const { readSessionEndFrame } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);
const { settleGraphSessionEnd } = await import(
  pathToFileURL(join(__dirname, 'lib', 'graph-session-settlement.mjs')).href
);

function writeSafeContinue() {
  process.stdout.write(`${JSON.stringify(SAFE_CONTINUE)}\n`);
}

async function main() {
  const frame = await readSessionEndFrame();
  if (frame.status !== 'ok') {
    writeSafeContinue();
    return;
  }

  await settleGraphSessionEnd(frame.value);

  writeSafeContinue();
}

main().catch(writeSafeContinue);
