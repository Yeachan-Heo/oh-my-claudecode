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
describe('parseRuleFrontmatter brace globs', () => {
    const parseGlobs = (line) => parseRuleFrontmatter(`---\n${line}\n---\nbody`).metadata.globs;
    it('keeps commas inside braces in a bare string value', () => {
        expect(parseGlobs('paths: src/**/*.{ts,tsx}')).toEqual(['src/**/*.{ts,tsx}']);
        expect(parseGlobs('paths: src/*.{ts,tsx,}')).toEqual(['src/*.{ts,tsx,}']);
    });
    it('still splits comma-separated patterns outside braces', () => {
        expect(parseGlobs('globs: a/*.{ts,tsx}, b/*.md')).toEqual(['a/*.{ts,tsx}', 'b/*.md']);
        expect(parseGlobs('globs: **/*.ts,**/*.tsx')).toEqual(['**/*.ts', '**/*.tsx']);
        expect(parseGlobs("globs: \"docs/what's-new.md, src/*.ts\"")).toEqual([
            "docs/what's-new.md",
            'src/*.ts',
        ]);
        expect(parseGlobs("globs: docs/what's-new.md, src/*.ts")).toEqual([
            "docs/what's-new.md",
            'src/*.ts',
        ]);
        expect(parseGlobs('globs: a{b.ts, docs/*.md')).toEqual(['a{b.ts', 'docs/*.md']);
        expect(parseGlobs('paths: [a{b.ts, docs/*.md]')).toEqual(['a{b.ts', 'docs/*.md']);
    });
    it('keeps commas inside braces in an unquoted inline array item', () => {
        expect(parseGlobs('paths: [src/*.{ts,tsx}, docs/*.md]')).toEqual(['src/*.{ts,tsx}', 'docs/*.md']);
        expect(parseGlobs('paths: [src/*.{ts,tsx,}, docs/*.md]')).toEqual(['src/*.{ts,tsx,}', 'docs/*.md']);
        expect(parseGlobs("paths: [docs/what's-new.md, src/*.ts]")).toEqual(["docs/what's-new.md", 'src/*.ts']);
        expect(parseGlobs('paths: ["src/*.{ts,tsx}", "docs/*.md"]')).toEqual(['src/*.{ts,tsx}', 'docs/*.md']);
        expect(parseGlobs(String.raw `globs: ['fixtures/\{a,b\}.json']`)).toEqual([
            String.raw `fixtures/\{a,b\}.json`,
        ]);
    });
    it('preserves escaped literal brace globs in a block array', () => {
        const literalGlob = String.raw `fixtures/\{a,b\}.json`;
        const { metadata } = parseRuleFrontmatter(`---\nglobs:\n  - '${literalGlob}'\n---\nbody`);
        expect(metadata.globs).toEqual([literalGlob]);
    });
    it('merges paths and globs without splitting brace alternatives', () => {
        const { metadata } = parseRuleFrontmatter([
            '---',
            'paths: src/**/*.{ts,tsx}',
            'globs: "**/*.md"',
            '---',
            'body',
        ].join('\n'));
        expect(metadata.globs).toEqual(['src/**/*.{ts,tsx}', '**/*.md']);
    });
});
describe('parseRuleFrontmatter UTF-8 BOM', () => {
    it('parses a rule file that starts with a BOM', () => {
        const { metadata, body } = parseRuleFrontmatter('\uFEFF---\nglobs: "src/**/*.ts"\nalwaysApply: false\n---\nrule\uFEFF body');
        expect(metadata.globs).toBe('src/**/*.ts');
        expect(body).toBe('rule\uFEFF body');
    });
});
describe('parseRuleFrontmatter unindented block sequences', () => {
    const parseGlobs = (yaml) => parseRuleFrontmatter(`---\n${yaml}\n---\nbody`).metadata.globs;
    it('reads list items written at the same indentation as their key', () => {
        expect(parseGlobs('paths:\n- src/**/*.ts\n- "lib/**"')).toEqual(['src/**/*.ts', 'lib/**']);
        expect(parseGlobs('globs:\n- "**/*.py"')).toEqual(['**/*.py']);
    });
    it('stops at the next key after an unindented list', () => {
        const { metadata } = parseRuleFrontmatter('---\npaths:\n- src/**\nalwaysApply: true\n---\nbody');
        expect(metadata.globs).toEqual(['src/**']);
        expect(metadata.alwaysApply).toBe(true);
    });
    it('still reads indented lists and CRLF lists', () => {
        expect(parseGlobs('paths:\n  - src/**')).toEqual(['src/**']);
        expect(parseRuleFrontmatter('---\r\npaths:\r\n- src/**\r\n---\r\nbody').metadata.globs).toEqual(['src/**']);
    });
});
describe('parseRuleFrontmatter trailing comments', () => {
    const parse = (yaml) => parseRuleFrontmatter(`---\n${yaml}\n---\nbody`).metadata;
    it('ignores a comment after alwaysApply', () => {
        expect(parse('alwaysApply: true # applies everywhere').alwaysApply).toBe(true);
    });
    it('ignores a comment after a scalar glob', () => {
        expect(parse('globs: "src/**/*.ts" # typescript only').globs).toBe('src/**/*.ts');
        expect(parse('paths: src/**/*.ts   # typescript only').globs).toBe('src/**/*.ts');
    });
    it('ignores comments after list items and after the key', () => {
        expect(parse('paths: # rule targets\n  - "src/**" # code\n  - lib/**')).toEqual({
            globs: ['src/**', 'lib/**'],
        });
    });
    it('ignores a comment after an inline array', () => {
        expect(parse('globs: ["a/**", "b/**"] # both').globs).toEqual(['a/**', 'b/**']);
    });
    it('keeps # inside quotes and glued to non-space text', () => {
        expect(parse('globs: "docs/ #notes/**"').globs).toBe('docs/ #notes/**');
        expect(parse('globs: docs/#notes/**').globs).toBe('docs/#notes/**');
        expect(parse('globs: docs/#notes/** # rule target').globs).toBe('docs/#notes/**');
        expect(parse('globs: ["docs/ #notes/**", "src/**"] # both').globs).toEqual([
            'docs/ #notes/**',
            'src/**',
        ]);
        expect(parse('globs:\n  - "docs/ #notes/**" # docs').globs).toEqual([
            'docs/ #notes/**',
        ]);
    });
});
//# sourceMappingURL=parser.test.js.map