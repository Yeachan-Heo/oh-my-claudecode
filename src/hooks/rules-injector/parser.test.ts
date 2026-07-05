import { describe, expect, it } from 'vitest';

import { parseRuleFrontmatter } from './parser.js';

// Rule files authored on Windows use CRLF line endings. The frontmatter
// delimiter regex tolerates `\r`, but the multi-line array branch matches
// items with `/^\s+-\s*(.*)$/`, and JS `.`/`$` do not span a trailing `\r`.
// Without normalising line endings, a `\r`-terminated `  - pattern` item
// fails to match and the whole array collapses (globs -> ''), so the rule
// silently applies to nothing.
describe('parseRuleFrontmatter line endings', () => {
  it('parses a multi-line globs array with CRLF line endings', () => {
    const content = [
      '---',
      'globs:',
      '  - "**/*.py"',
      '  - "src/**/*.ts"',
      'alwaysApply: false',
      '---',
      'body',
    ].join('\r\n');

    const { metadata } = parseRuleFrontmatter(content);

    expect(metadata.globs).toEqual(['**/*.py', 'src/**/*.ts']);
  });

  it('matches the LF result for the same multi-line array', () => {
    const lines = [
      '---',
      'globs:',
      '  - "**/*.py"',
      '  - "src/**/*.ts"',
      '---',
      'body',
    ];

    const lf = parseRuleFrontmatter(lines.join('\n'));
    const crlf = parseRuleFrontmatter(lines.join('\r\n'));

    expect(crlf.metadata).toEqual(lf.metadata);
  });

  it('parses a multi-line paths alias array with CRLF line endings', () => {
    const content = [
      '---',
      'paths:',
      '  - "*.md"',
      '---',
      'body',
    ].join('\r\n');

    const { metadata } = parseRuleFrontmatter(content);

    expect(metadata.globs).toEqual(['*.md']);
  });
});
