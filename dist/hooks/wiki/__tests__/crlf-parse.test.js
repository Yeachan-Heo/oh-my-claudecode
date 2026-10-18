import { describe, it, expect } from 'vitest';
import { parseFrontmatter } from '../storage.js';
describe('parseFrontmatter CRLF handling', () => {
    it('should parse LF frontmatter (baseline)', () => {
        const raw = '---\ntitle: Test\ntags: []\n---\n\n# Content\n';
        const result = parseFrontmatter(raw);
        expect(result).not.toBeNull();
        expect(result.frontmatter.title).toBe('Test');
    });
    it('should parse CRLF frontmatter', () => {
        const raw = '---\r\ntitle: Test\r\ntags: []\r\n---\r\n\r\n# Content\r\n';
        const result = parseFrontmatter(raw);
        expect(result).not.toBeNull();
        expect(result.frontmatter.title).toBe('Test');
    });
    it('should parse mixed line endings', () => {
        const raw = '---\r\ntitle: Mixed\ntags: []\r\n---\n\n# Content\n';
        const result = parseFrontmatter(raw);
        expect(result).not.toBeNull();
        expect(result.frontmatter.title).toBe('Mixed');
    });
});
//# sourceMappingURL=crlf-parse.test.js.map