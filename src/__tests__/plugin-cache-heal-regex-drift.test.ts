import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = join(__dirname, '..', '..');

/**
 * Regex drift check.
 *
 * The absolute-node-path detection regex lives in two places:
 *   - scripts/plugin-setup.mjs (consumed at npm postinstall time, before
 *     dist/ exists, so it can't import from compiled TS)
 *   - src/installer/plugin-cache-heal.ts (consumed at runtime via dist/)
 *
 * They MUST stay in sync, otherwise a future patch could quietly break
 * heal/prune in only one of the two surfaces. This test pins the literal
 * regex source on both sides and asserts byte equality.
 */
describe('absolute-node-path regex drift', () => {
  it('plugin-setup.mjs and plugin-cache-heal.ts ship the same regex', () => {
    const mjs = readFileSync(join(PACKAGE_ROOT, 'scripts', 'plugin-setup.mjs'), 'utf-8');
    const ts = readFileSync(join(PACKAGE_ROOT, 'src', 'installer', 'plugin-cache-heal.ts'), 'utf-8');

    // Match the literal regex line on each side. Both files use the same
    // pattern, so we extract by anchoring on `CLAUDE_PLUGIN_ROOT.*scripts\/run\.cjs`.
    const regexLineRe = /\/\^"\(\[\^"\]\+\)"[^\n]*scripts\\\/run\\\.cjs[^\n]*\$\//;

    const mjsMatch = mjs.match(regexLineRe);
    const tsMatch = ts.match(regexLineRe);

    expect(mjsMatch).not.toBeNull();
    expect(tsMatch).not.toBeNull();
    expect(mjsMatch![0]).toBe(tsMatch![0]);
  });
});
