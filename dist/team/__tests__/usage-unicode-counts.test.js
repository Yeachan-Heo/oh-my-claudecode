import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureCharCounts } from '../usage-tracker.js';
const fixtures = [];
function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'omc-unicode-usage-'));
    fixtures.push(directory);
    return directory;
}
afterEach(() => {
    for (const directory of fixtures.splice(0))
        rmSync(directory, { recursive: true, force: true });
});
describe('usage character counts', () => {
    it('counts Unicode code points rather than UTF-8 bytes or UTF-16 units', () => {
        const directory = fixture();
        const prompt = join(directory, 'prompt.md');
        const output = join(directory, 'output.md');
        writeFileSync(prompt, '日本語😀');
        writeFileSync(output, 'é e\u0301');
        expect(measureCharCounts(prompt, output)).toEqual({ promptChars: 4, responseChars: 4 });
    });
    it('keeps multibyte characters intact across bounded reads of large output', () => {
        const directory = fixture();
        const output = join(directory, 'output.md');
        const block = 'a'.repeat(65535) + '😀日本語';
        writeFileSync(output, block.repeat(32));
        expect(measureCharCounts(join(directory, 'missing'), output)).toEqual({
            promptChars: 0, responseChars: (65535 + 4) * 32,
        });
    });
    it('preserves ASCII, empty and unreadable-file controls', () => {
        const directory = fixture();
        const prompt = join(directory, 'prompt.md');
        const output = join(directory, 'output.md');
        writeFileSync(prompt, 'hello\n');
        writeFileSync(output, '');
        expect(measureCharCounts(prompt, output)).toEqual({ promptChars: 6, responseChars: 0 });
        expect(measureCharCounts(directory, join(directory, 'missing'))).toEqual({ promptChars: 0, responseChars: 0 });
    });
});
//# sourceMappingURL=usage-unicode-counts.test.js.map