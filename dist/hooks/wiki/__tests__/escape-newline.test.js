import { describe, it, expect } from 'vitest';
import { serializePage, parseFrontmatter } from '../storage.js';
import { WIKI_SCHEMA_VERSION } from '../types.js';
function makePage(title) {
    return {
        filename: 'test.md',
        frontmatter: {
            title, tags: [], created: '2025-01-01T00:00:00.000Z',
            updated: '2025-01-01T00:00:00.000Z', sources: [], links: [],
            category: 'reference', confidence: 'medium', schemaVersion: WIKI_SCHEMA_VERSION,
        },
        content: '\n# Test\n',
    };
}
describe('escapeYaml newline handling', () => {
    it('should roundtrip title with newline', () => {
        const page = makePage('Line1\nLine2');
        const raw = serializePage(page);
        expect(raw).toContain('title: "Line1\\nLine2"');
        const parsed = parseFrontmatter(raw);
        expect(parsed).not.toBeNull();
        expect(parsed.frontmatter.title).toBe('Line1\nLine2');
    });
    it('should roundtrip title with carriage return', () => {
        const page = makePage('Before\rAfter');
        const raw = serializePage(page);
        const parsed = parseFrontmatter(raw);
        expect(parsed.frontmatter.title).toBe('Before\rAfter');
    });
    it('should roundtrip literal backslash-n without corruption (regression)', () => {
        const page = makePage('Windows\\new');
        const raw = serializePage(page);
        const parsed = parseFrontmatter(raw);
        expect(parsed).not.toBeNull();
        expect(parsed.frontmatter.title).toBe('Windows\\new');
    });
    it('should roundtrip backslash followed by actual newline', () => {
        const page = makePage('path\\\nline2');
        const raw = serializePage(page);
        const parsed = parseFrontmatter(raw);
        expect(parsed.frontmatter.title).toBe('path\\\nline2');
    });
});
//# sourceMappingURL=escape-newline.test.js.map