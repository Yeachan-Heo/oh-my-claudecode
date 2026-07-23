#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SAFE_CONTINUE = { continue: true, suppressOutput: true };
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SETTLE_TIMEOUT_MS = 2_000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const { readSessionEndFrame } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);
const { resolveSessionStatePathsForHook } = await import(
  pathToFileURL(join(__dirname, 'lib', 'state-root.mjs')).href
);

function writeSafeContinue() {
  process.stdout.write(`${JSON.stringify(SAFE_CONTINUE)}\n`);
}

// Per-invocation nonce so a second SessionEnd in the same session produces a
// distinct transition_id. A stable per-session+path digest would replay the
// first invocation's recorded result (store idempotency) and could never
// settle claims created since the prior session-end. The nonce is mixed into
// the hash so the transition_id remains opaque but unique per firing.
function stableTransitionId(sessionId, graphPath, nonce) {
  const digest = createHash('sha256')
    .update(`${sessionId}\0${graphPath}\0${nonce}`)
    .digest('hex')
    .slice(0, 32);
  return `session-end:${digest}`;
}

// Best-effort per-invocation nonce. Prefer a high-resolution timestamp so
// successive session-ends within one session are ordered and distinct; fall
// back to a random value if hrtime is unavailable.
function invocationNonce() {
  try {
    const [seconds, nanos] = process.hrtime();
    return `${seconds}.${nanos}`;
  } catch {
    return `${Math.random().toString(36).slice(2)}-${Date.now()}`;
  }
}

async function main() {
  const frame = await readSessionEndFrame();
  if (frame.status !== 'ok') {
    writeSafeContinue();
    return;
  }

  const input = frame.value;
  const sessionId = input && typeof input === 'object' && typeof input.session_id === 'string'
    ? input.session_id
    : '';
  const cwd = input && typeof input === 'object' && typeof input.cwd === 'string'
    ? resolve(input.cwd)
    : '';

  if (!SESSION_ID.test(sessionId) || !cwd) {
    writeSafeContinue();
    return;
  }

  try {
    const { writePath } = await resolveSessionStatePathsForHook(cwd, 'graph', sessionId);
    if (!existsSync(writePath)) {
      writeSafeContinue();
      return;
    }

    spawnSync('omc', [
      'graph',
      'settle-session',
      '--session-id', sessionId,
      '--driver-id', 'session-end',
      '--transition-id', stableTransitionId(sessionId, writePath, invocationNonce()),
      '--json',
    ], {
      cwd,
      env: process.env,
      shell: false,
      stdio: 'ignore',
      timeout: SETTLE_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch {
    // The durable runtime can recover an un-settled lease after this bounded hook exits.
  }

  writeSafeContinue();
}

main().catch(writeSafeContinue);
