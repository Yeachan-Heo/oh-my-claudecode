import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = join(__dirname, '..', '..');
const PLUGIN_SETUP_PATH = join(PACKAGE_ROOT, 'scripts', 'plugin-setup.mjs');
/**
 * Regression test for duplicate devPaths in plugin-setup.mjs HUD wrapper.
 *
 * The generated HUD wrapper script (omc-hud.mjs) had 4 entries in the
 * devPaths array where entries 3-4 were exact duplicates of entries 1-2.
 * This test ensures devPaths contains no duplicate entries.
 */
describe('plugin-setup.mjs devPaths deduplication', () => {
    const scriptContent = existsSync(PLUGIN_SETUP_PATH)
        ? readFileSync(PLUGIN_SETUP_PATH, 'utf-8')
        : '';
    it('script file exists', () => {
        expect(existsSync(PLUGIN_SETUP_PATH)).toBe(true);
    });
    it('devPaths array has no duplicate entries', () => {
        // Extract the devPaths array block from the script
        const devPathsMatch = scriptContent.match(/const devPaths\s*=\s*\[([\s\S]*?)\];/);
        expect(devPathsMatch).not.toBeNull();
        // Extract individual path strings from the array
        const arrayContent = devPathsMatch[1];
        const pathEntries = arrayContent
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.startsWith('join('));
        // Verify no duplicates
        const uniqueEntries = new Set(pathEntries);
        expect(pathEntries.length).toBe(uniqueEntries.size);
        expect(pathEntries.length).toBeGreaterThan(0);
    });
    it('devPaths contains both Workspace and workspace variants', () => {
        // Ensure we still have both case variants (capital W and lowercase w)
        const devPathsMatch = scriptContent.match(/const devPaths\s*=\s*\[([\s\S]*?)\];/);
        expect(devPathsMatch).not.toBeNull();
        const arrayContent = devPathsMatch[1];
        expect(arrayContent).toContain('"Workspace/oh-my-claudecode/dist/hud/index.js"');
        expect(arrayContent).toContain('"workspace/oh-my-claudecode/dist/hud/index.js"');
    });
});
//# sourceMappingURL=plugin-setup-devpaths.test.js.map