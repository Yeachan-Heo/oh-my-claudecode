import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveSessionStatePathsForHook } from './state-root.mjs';

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SETTLE_TIMEOUT_MS = 2_000;

function transitionId(sessionId, graphPath) {
  const nonce = `${process.hrtime.bigint()}-${Math.random().toString(36).slice(2)}`;
  const digest = createHash('sha256')
    .update(`${sessionId}\0${graphPath}\0${nonce}`)
    .digest('hex')
    .slice(0, 32);
  return `session-end:${digest}`;
}

/**
 * Ask the Graph runtime to fence and settle claims for this SessionEnd.
 * Graph CLI owns the mutation so plugin and standalone delivery use the same
 * transition authority and recovery semantics.
 */
export async function settleGraphSessionEnd(input) {
  const sessionId = input && typeof input === 'object' && typeof input.session_id === 'string'
    ? input.session_id
    : '';
  const cwd = input && typeof input === 'object' && typeof input.cwd === 'string'
    ? resolve(input.cwd)
    : '';
  if (!SESSION_ID.test(sessionId) || !cwd) return;

  try {
    const { writePath } = await resolveSessionStatePathsForHook(cwd, 'graph', sessionId);
    // The OCC journal is authoritative when present, but standalone installs
    // and legacy state can have only the canonical cache. Either durable signal
    // requires settlement; the CLI validates the state before mutating it.
    if (!existsSync(writePath) && !existsSync(`${writePath}.journal`)) return;
    spawnSync('omc', [
      'graph',
      'settle-session',
      '--session-id', sessionId,
      '--driver-id', 'session-end',
      '--transition-id', transitionId(sessionId, writePath),
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
    // The durable Graph runtime recovers an un-settled lease after hook exit.
  }
}
