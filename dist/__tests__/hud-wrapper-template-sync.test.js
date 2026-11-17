import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHudWrapper as buildHudWrapperTs } from '../lib/hud-wrapper-template.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..', '..');
const TS_PATH = join(root, 'src', 'lib', 'hud-wrapper-template.ts');
const MJS_PATH = join(root, 'scripts', 'lib', 'hud-wrapper-template.mjs');
describe('HUD wrapper template — TS/MJS sync', () => {
    it('TS module reads scripts/lib/hud-wrapper-template.txt', () => {
        const src = readFileSync(TS_PATH, 'utf8');
        expect(src).toMatch(/readFileSync\(/);
        expect(src).toMatch(/['"]scripts['"],\s*['"]lib['"],\s*['"]hud-wrapper-template\.txt['"]/);
    });
    it('MJS shim reads scripts/lib/hud-wrapper-template.txt', () => {
        const src = readFileSync(MJS_PATH, 'utf8');
        // The MJS shim joins __dirname with the filename, so the literal path
        // string is just the basename. Match either form.
        expect(src).toMatch(/hud-wrapper-template\.txt/);
        expect(src).toMatch(/readFileSync\(/);
    });
    it('TS and MJS readers return byte-identical content', async () => {
        const fromTs = buildHudWrapperTs(root);
        const mjsModule = await import(
        /* @vite-ignore */ `file://${MJS_PATH}`);
        const fromMjs = mjsModule.buildHudWrapper();
        expect(fromMjs).toBe(fromTs);
    });
});
//# sourceMappingURL=hud-wrapper-template-sync.test.js.map