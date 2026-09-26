import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Mirror the resolver's key, master-off, point, wildcard, and :active gates. */
export function isJevShadowOptedIn(point, env = process.env) {
  const raw = (env.OMC_JEV || '').trim();
  if (!env.TYPESAFE_API_KEY || raw === 'off') return false;

  for (const entry of raw.split(',')) {
    const token = entry.trim();
    if (!token) continue;
    const colon = token.lastIndexOf(':');
    const name = colon === -1 ? token : token.slice(0, colon);
    if (name === 'all' || name === point) return true;
  }
  return false;
}

/** Fire-and-record one script-side judgment without affecting its caller. */
export function recordJevShadow({ point, state, questions, heuristic }) {
  if (!isJevShadowOptedIn(point)) return;

  try {
    const requestFile = join(mkdtempSync(join(tmpdir(), 'omc-jev-')), 'request.json');
    writeFileSync(requestFile, JSON.stringify({ point, state, questions, heuristic }), {
      encoding: 'utf8',
      mode: 0o600,
    });
    const child = spawn(process.execPath, [
      fileURLToPath(new URL('../jev-resolve.mjs', import.meta.url)),
      '--request-file',
      requestFile,
    ], {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: process.env,
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Jev logging is advisory; temp-file or spawn failures never affect hooks.
  }
}
