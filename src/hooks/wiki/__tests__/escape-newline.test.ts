import { describe, it, expect } from 'vitest';
import { serializePage, parseFrontmatter } from '../storage.js';
import { WIKI_SCHEMA_VERSION } from '../types.js';
import type { WikiPage } from '../types.js';

function makePage(title: string): WikiPage {
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
    expect(parsed!.frontmatter.title).toBe('Line1\nLine2');
  });

  it('should roundtrip title with carriage return', () => {
    const page = makePage('Before\rAfter');
    const raw = serializePage(page);
    const parsed = parseFrontmatter(raw);
    expect(parsed!.frontmatter.title).toBe('Before\rAfter');
  });

  it('should roundtrip literal backslash-n without corruption (regression)', () => {
    const page = makePage('Windows\\new');
    const raw = serializePage(page);
    const parsed = parseFrontmatter(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter.title).toBe('Windows\\new');
  });

  it('should roundtrip backslash followed by actual newline', () => {
    const page = makePage('path\\\nline2');
    const raw = serializePage(page);
    const parsed = parseFrontmatter(raw);
    expect(parsed!.frontmatter.title).toBe('path\\\nline2');
  });
});

describe('flow-sequence frontmatter fields with commas', () => {
  it('roundtrips tags, sources and links containing commas', () => {
    const page = makePage('Commas');
    page.frontmatter.tags = ['a, b', 'plain', 'say "hi", twice'];
    page.frontmatter.sources = ['https://example.com/search?q=a,b', 'notes, draft'];
    page.frontmatter.links = ['page-one', 'page, two'];

    const parsed = parseFrontmatter(serializePage(page));

    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter.tags).toEqual(['a, b', 'plain', 'say "hi", twice']);
    expect(parsed!.frontmatter.sources).toEqual(['https://example.com/search?q=a,b', 'notes, draft']);
    expect(parsed!.frontmatter.links).toEqual(['page-one', 'page, two']);
  });

  it('still splits hand-written unquoted and single-quoted items', () => {
    const raw = [
      '---',
      'title: "Hand written"',
      "tags: [alpha, don't, 'x, y', \"p, q\"]",
      'sources: []',
      'links: []',
      '---',
      'body',
    ].join('\n');

    const parsed = parseFrontmatter(raw);

    expect(parsed!.frontmatter.tags).toEqual(['alpha', "don't", 'x, y', 'p, q']);
  });

  it('decodes doubled apostrophes in single-quoted array fields', () => {
    const raw = [
      '---',
      'title: "Hand written"',
      "tags: ['tag''s, note', plain]",
      "sources: ['source''s, name']",
      "links: ['link''s, title']",
      '---',
      'body',
    ].join('\n');

    const parsed = parseFrontmatter(raw);

    expect(parsed!.frontmatter.tags).toEqual(["tag's, note", 'plain']);
    expect(parsed!.frontmatter.sources).toEqual(["source's, name"]);
    expect(parsed!.frontmatter.links).toEqual(["link's, title"]);
  });

  it('preserves backslashes in single-quoted scalar and array fields', () => {
    const raw = [
      '---',
      "title: 'C:\\repo\\notes'",
      "tags: []",
      "sources: ['C:\\repo\\notes, draft']",
      "links: []",
      '---',
      'body',
    ].join('\n');

    const parsed = parseFrontmatter(raw);

    expect(parsed!.frontmatter.title).toBe('C:\\repo\\notes');
    expect(parsed!.frontmatter.sources).toEqual(['C:\\repo\\notes, draft']);
  });
});
