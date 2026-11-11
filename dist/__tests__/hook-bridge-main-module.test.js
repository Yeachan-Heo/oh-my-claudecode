import { describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isSameEntryRealpath } from '../hooks/bridge.js';
/**
 * B7 regression: when OMC is installed via a symlink
 * (e.g. ~/.local/bin/omc -> checkout's bridge/cli.cjs), the bridge entry's
 * main-module check must dispatch instead of exiting silently.
 */
describe('isSameEntryRealpath (bridge main-module check)', () => {
    it('treats a symlinked entry as the main module (B7)', () => {
        const dir = mkdtempSync(join(tmpdir(), 'omc-bridge-entry-'));
        const realFile = join(dir, 'cli.cjs');
        writeFileSync(realFile, '// entry\n');
        const link = join(dir, 'omc');
        symlinkSync(realFile, link, 'file');
        const moduleUrl = pathToFileURL(realFile).href;
        const entryUrl = pathToFileURL(link).href;
        expect(entryUrl).not.toBe(moduleUrl);
        expect(isSameEntryRealpath(entryUrl, moduleUrl)).toBe(true);
        expect(realpathSync(link)).toBe(realpathSync(realFile));
    });
    it('returns true for an identical URL', () => {
        const moduleUrl = pathToFileURL(join('some', 'cli.cjs')).href;
        expect(isSameEntryRealpath(moduleUrl, moduleUrl)).toBe(true);
    });
    it('returns true for a missing entry URL (legacy bundle behavior)', () => {
        expect(isSameEntryRealpath(undefined, 'file:///x/cli.cjs')).toBe(true);
    });
    it('returns false for a genuinely different file', () => {
        const dir = mkdtempSync(join(tmpdir(), 'omc-bridge-entry-'));
        const a = join(dir, 'a.cjs');
        const b = join(dir, 'b.cjs');
        writeFileSync(a, '// a\n');
        writeFileSync(b, '// b\n');
        expect(isSameEntryRealpath(pathToFileURL(a).href, pathToFileURL(b).href)).toBe(false);
    });
    it('returns false when the entry path does not exist', () => {
        const dir = mkdtempSync(join(tmpdir(), 'omc-bridge-entry-'));
        const realFile = join(dir, 'cli.cjs');
        writeFileSync(realFile, '// entry\n');
        const missing = join(dir, 'does-not-exist.cjs');
        expect(isSameEntryRealpath(pathToFileURL(missing).href, pathToFileURL(realFile).href)).toBe(false);
    });
});
//# sourceMappingURL=hook-bridge-main-module.test.js.map