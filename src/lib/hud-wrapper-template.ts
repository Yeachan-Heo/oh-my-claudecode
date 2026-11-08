/**
 * HUD wrapper template reader (TS side).
 *
 * Single source of truth for the `omc-hud.mjs` statusline wrapper body
 * used by `src/installer/index.ts` (Path A: `omc setup` / npm).
 *
 * The JS mirror lives at `scripts/lib/hud-wrapper-template.mjs` and is
 * used by `scripts/plugin-setup.mjs` (Path B: Claude Code plugin
 * marketplace). Both must read the same `.txt` file — drift is
 * enforced by `src/__tests__/hud-wrapper-template-sync.test.ts`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Returns the HUD wrapper script body, read from
 * `scripts/lib/hud-wrapper-template.txt`.
 *
 * @param packageDir Absolute path to the package root (caller-provided
 *   so this module stays free of `getPackageDir()` resolution logic).
 */
export function buildHudWrapper(packageDir: string): string {
  return readFileSync(
    join(packageDir, 'scripts', 'lib', 'hud-wrapper-template.txt'),
    'utf8',
  );
}
