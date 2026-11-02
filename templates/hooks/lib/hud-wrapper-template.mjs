/**
 * HUD wrapper template reader (JS mirror).
 *
 * This is the JS mirror of src/lib/hud-wrapper-template.ts. Both must
 * read the same .txt file. Keep them in sync — enforced by
 * src/__tests__/hud-wrapper-template-sync.test.ts.
 *
 * Used by scripts/plugin-setup.mjs (Path B: Claude Code plugin marketplace).
 * The TS module is used by src/installer/index.ts (Path A: `omc setup` / npm).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, 'hud-wrapper-template.txt');

export function buildHudWrapper() {
  return readFileSync(TEMPLATE_PATH, 'utf8');
}

export const HUD_WRAPPER_TEMPLATE_PATH = TEMPLATE_PATH;
