import { describe, it, expect } from 'vitest';
import { stripOptionalQuotes, parseFrontmatter, parseFrontmatterAliases, parseFrontmatterList, splitFlowSequenceItems } from '../frontmatter.js';

describe('stripOptionalQuotes', () => {
  it('strips double quotes', () => {
    expect(stripOptionalQuotes('"hello"')).toBe('hello');
  });

  it('strips single quotes', () => {
    expect(stripOptionalQuotes("'hello'")).toBe('hello');
  });

  it('trims whitespace before stripping', () => {
    expect(stripOptionalQuotes('  "hello"  ')).toBe('hello');
  });

  it('does not strip mismatched quotes', () => {
    expect(stripOptionalQuotes('"hello\'')).toBe('"hello\'');
  });

  it('returns unquoted strings as-is', () => {
    expect(stripOptionalQuotes('hello')).toBe('hello');
  });

  it('handles empty string', () => {
    expect(stripOptionalQuotes('')).toBe('');
  });

  it('handles string with only quotes', () => {
    expect(stripOptionalQuotes('""')).toBe('');
  });

  it('trims inner whitespace after stripping quotes', () => {
    expect(stripOptionalQuotes('" hello "')).toBe('hello');
  });
});

describe('parseFrontmatter', () => {
  it('parses valid frontmatter', () => {
    const content = `---
name: my-skill
description: A test skill
---
Body content here`;
    const result = parseFrontmatter(content);
    expect(result.metadata).toEqual({
      name: 'my-skill',
      description: 'A test skill',
    });
    expect(result.body).toBe('Body content here');
  });

  it('returns empty metadata when no frontmatter', () => {
    const content = 'Just some plain text';
    const result = parseFrontmatter(content);
    expect(result.metadata).toEqual({});
    expect(result.body).toBe('Just some plain text');
  });

  it('handles quoted values', () => {
    const content = `---
name: "quoted-name"
aliases: 'single-quoted'
---
Body`;
    const result = parseFrontmatter(content);
    expect(result.metadata.name).toBe('quoted-name');
    expect(result.metadata.aliases).toBe('single-quoted');
  });

  it('handles values with colons', () => {
    const content = `---
url: https://example.com:8080/path
---
Body`;
    const result = parseFrontmatter(content);
    expect(result.metadata.url).toBe('https://example.com:8080/path');
  });

  it('skips lines without colons', () => {
    const content = `---
name: valid
this-has-no-value
another: valid-too
---
Body`;
    const result = parseFrontmatter(content);
    expect(result.metadata).toEqual({
      name: 'valid',
      another: 'valid-too',
    });
  });

  it('handles empty frontmatter', () => {
    const content = `---

---
Body`;
    const result = parseFrontmatter(content);
    expect(result.metadata).toEqual({});
    expect(result.body).toBe('Body');
  });

  it('handles Windows-style line endings', () => {
    const content = '---\r\nname: test\r\n---\r\nBody';
    const result = parseFrontmatter(content);
    expect(result.metadata.name).toBe('test');
    expect(result.body).toBe('Body');
  });

  it('handles mixed LF and CRLF while preserving the body', () => {
    const body = 'Body\r\nwith mixed\nline endings\r\n';
    const content = `---\r\nname: mixed\ndescription: Mixed separators\r\n---\n${body}`;
    const result = parseFrontmatter(content);

    expect(result.metadata).toEqual({
      name: 'mixed',
      description: 'Mixed separators'
    });
    expect(result.body).toBe(body);
  });

  it('does not treat a bare carriage return as a frontmatter separator', () => {
    const partialOpen = '---\rname: test\n---\nBody';
    const partialClose = '---\nname: test\n---\rBody';

    expect(parseFrontmatter(partialOpen)).toEqual({
      metadata: {},
      body: partialOpen
    });
    expect(parseFrontmatter(partialClose)).toEqual({
      metadata: {},
      body: partialClose
    });
  });

  it('handles empty body', () => {
    const content = `---
name: test
---
`;
    const result = parseFrontmatter(content);
    expect(result.metadata.name).toBe('test');
    expect(result.body).toBe('');
  });

  it('handles multiline body', () => {
    const content = `---
name: test
---
Line 1
Line 2
Line 3`;
    const result = parseFrontmatter(content);
    expect(result.body).toBe('Line 1\nLine 2\nLine 3');
  });

  it('does not promote nested mapping fields to top-level metadata', () => {
    const content = `---
name: compatibility-skill
description: Top-level description
metadata:
  integration:
    description: Nested integration description
    model: nested-model
---
Body`;
    const result = parseFrontmatter(content);

    expect(result.metadata).toEqual({
      name: 'compatibility-skill',
      description: 'Top-level description',
      metadata: '',
    });
  });

  it('preserves uniformly indented root mappings without promoting nested fields', () => {
    const content = `---
# comment: does not define mapping indentation
  name: indented-skill
  description: Indented root description
  model: opus
  metadata:
    description: Nested description
    model: nested-model
---
Body`;
    const result = parseFrontmatter(content);

    expect(result.metadata).toEqual({
      name: 'indented-skill',
      description: 'Indented root description',
      model: 'opus',
      metadata: '',
    });
  });

  it('ignores de-indented members of multiline flow mappings', () => {
    const content = `---
  name: indented-skill
  metadata: {
integration: remote,
model: nested-model
  }
  description: Root description
---
Body`;
    const result = parseFrontmatter(content);

    expect(result.metadata).toEqual({
      name: 'indented-skill',
      metadata: '{',
      description: 'Root description',
    });
  });


  it('ignores nested members of same-indent multiline flow mappings', () => {
    const content = `---
name: example-skill
description: Top-level description
metadata: {
description: Nested,
model: nested
}
---
Body`;
    const result = parseFrontmatter(content);

    expect(result.metadata).toEqual({
      name: 'example-skill',
      description: 'Top-level description',
      metadata: '{',
    });
  });

  it('ignores nested members of same-indent multiline flow sequences', () => {
    const content = `---
name: example-skill
description: Top-level description
metadata: [
description: Nested,
model: nested
]
agent: coder
---
Body`;
    const result = parseFrontmatter(content);

    expect(result.metadata).toEqual({
      name: 'example-skill',
      description: 'Top-level description',
      metadata: '[',
      agent: 'coder',
    });
  });

  it('does not open flow tracking for braces embedded in plain scalar values', () => {
    const content = `---
name: example-skill
description: prose with { stray brace
model: opus
---
Body`;
    const result = parseFrontmatter(content);

    expect(result.metadata).toEqual({
      name: 'example-skill',
      description: 'prose with { stray brace',
      model: 'opus',
    });
  });
  it('ignores comments at the detected root indentation', () => {
    const content = `---
  name: indented-skill
  # fake: comment
  description: Root description
---
Body`;
    const result = parseFrontmatter(content);

    expect(result.metadata).toEqual({
      name: 'indented-skill',
      description: 'Root description',
    });
  });
});

describe('parseFrontmatterAliases', () => {
  it('parses inline YAML list', () => {
    expect(parseFrontmatterAliases('[foo, bar, baz]')).toEqual(['foo', 'bar', 'baz']);
  });

  it('parses single value', () => {
    expect(parseFrontmatterAliases('my-alias')).toEqual(['my-alias']);
  });

  it('returns empty array for undefined', () => {
    expect(parseFrontmatterAliases(undefined)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseFrontmatterAliases('')).toEqual([]);
  });

  it('returns empty array for whitespace-only string', () => {
    expect(parseFrontmatterAliases('   ')).toEqual([]);
  });

  it('handles quoted items in list', () => {
    expect(parseFrontmatterAliases('["foo", \'bar\']')).toEqual(['foo', 'bar']);
  });

  it('handles empty list', () => {
    expect(parseFrontmatterAliases('[]')).toEqual([]);
  });

  it('handles list with whitespace-only items', () => {
    expect(parseFrontmatterAliases('[foo, , bar]')).toEqual(['foo', 'bar']);
  });

  it('strips quotes from single value', () => {
    expect(parseFrontmatterAliases('"my-alias"')).toEqual(['my-alias']);
  });

  it('handles list with spaces around items', () => {
    expect(parseFrontmatterAliases('[ foo , bar , baz ]')).toEqual(['foo', 'bar', 'baz']);
  });
});

describe('parseFrontmatterList quoted commas', () => {
  it('keeps commas inside quoted items', () => {
    expect(parseFrontmatterList('["a, b", plain, \'x, y\']')).toEqual(['a, b', 'plain', 'x, y']);
  });

  it('does not let an escaped quote end a double-quoted item', () => {
    expect(parseFrontmatterList('["say \\"hi\\", twice", next]')).toEqual(['say \\"hi\\", twice', 'next']);
  });

  it('keeps commas inside single-quoted items with escaped apostrophes', () => {
    expect(splitFlowSequenceItems("'it''s, fine', next")).toEqual(["'it''s, fine'", ' next']);
    expect(parseFrontmatterList("['it''s, fine', next]")).toEqual(["it's, fine", 'next']);
  });

  it('treats a bare apostrophe as literal text', () => {
    expect(parseFrontmatterList("[don't, stop]")).toEqual(["don't", 'stop']);
  });

  it('still splits simple lists', () => {
    expect(parseFrontmatterList('[foo, bar,baz]')).toEqual(['foo', 'bar', 'baz']);
    expect(parseFrontmatterList('[]')).toEqual([]);
  });
});
