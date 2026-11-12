// Host helpers of the experimental Jev panel (negative result, see docs/jev/negative-results/jev-panel.md).
// The panel modules were written against a patched plugin that had a shell-check module with these helpers; here they are
// the small part the panel needs: the Jev log directory, one append-with-rotation helper, and the secret masking.
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { rotateJevLog } from '../jev-resolve.mjs';
import { maskSecrets } from './jev-sekrety.mjs';

export function shellLogDir(env = process.env) {
  return env.OMC_JEV_LOG_DIR || join(homedir(), '.omc', 'state', 'jev');
}

export function appendShellLog(name, row, env = process.env) {
  try {
    const dir = shellLogDir(env);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    rotateJevLog(path);
    appendFileSync(path, JSON.stringify(row) + '\n', 'utf8');
  } catch { /* logging never breaks the hook */ }
}

export { maskSecrets };
