import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderCwd } from '../../hud/elements/cwd.js';
function linkTarget(rendered) {
    const match = rendered.match(/^\x1b\]8;;([^\x1b]*)\x1b\\/);
    expect(match).not.toBeNull();
    return match[1];
}
describe('cwd hyperlink path boundary', () => {
    it('preserves the native filesystem root URL', () => {
        const root = parse(tmpdir()).root;
        const target = linkTarget(renderCwd(root, 'absolute', true));
        expect(target).toBe(pathToFileURL(root).href);
        expect(fileURLToPath(target)).toBe(root);
    });
    it('preserves the canonical URL for a Windows UNC share root', () => {
        if (process.platform !== 'win32')
            return;
        const root = '\\\\server\\share\\';
        const target = linkTarget(renderCwd(root, 'absolute', true));
        expect(target).toBe(pathToFileURL(root).href);
        expect(fileURLToPath(target)).toBe(root);
    });
    it('round trips an actual directory containing URL delimiters and literal percent signs', () => {
        const root = mkdtempSync(join(tmpdir(), 'omc-cwd-link-'));
        const directory = join(root, process.platform === 'win32' ? 'project# %' : 'project# % ? \\');
        mkdirSync(directory);
        try {
            const target = linkTarget(renderCwd(directory, 'absolute', true));
            expect(fileURLToPath(target)).toBe(directory);
            expect(new URL(target).hash).toBe('');
            expect(new URL(target).search).toBe('');
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
    it('encodes Windows drive path delimiters in portable string conversion', () => {
        const target = linkTarget(renderCwd('C:\\Users\\project# %?\\repo', 'absolute', true));
        expect(target).toBe('file:///C:/Users/project%23%20%25%3F/repo');
    });
    it.each(['absolute', 'relative', 'folder'])('does not emit filename terminal controls in %s display or its hyperlink', format => {
        if (process.platform === 'win32')
            return;
        const root = mkdtempSync(join(tmpdir(), 'omc-cwd-control-'));
        const directory = join(root, 'project\x1b]52;c;unsafe\x07');
        mkdirSync(directory);
        try {
            const plain = renderCwd(directory, format, false).replace(/\x1b\[[0-9;]*m/g, '');
            expect(plain).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
            const linked = renderCwd(directory, format, true);
            expect(fileURLToPath(linkTarget(linked))).toBe(directory);
            expect(linked).not.toContain('\x1b]52;');
            expect(linked).not.toContain('\x07');
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=cwd-hyperlink-boundary.test.js.map