import { describe, expect, it } from 'vitest';

import { shouldApplyRule } from './matcher.js';

const ROOT = '/repo';

function applies(globs: string | string[], relPath: string): boolean {
  return shouldApplyRule({ globs }, `${ROOT}/${relPath}`, ROOT).applies;
}

describe('shouldApplyRule glob matching', () => {
  // `**/` means zero or more directories, so the documented `**/*.py` and
  // `src/**/*.ts` forms must also match files at the root of that path.
  it('matches `**/*.py` at the project root and in subdirectories', () => {
    expect(applies('**/*.py', 'main.py')).toBe(true);
    expect(applies('**/*.py', 'pkg/a.py')).toBe(true);
    expect(applies('**/*.py', 'pkg/sub/a.py')).toBe(true);
    expect(applies('**/*.py', 'main.ts')).toBe(false);
  });

  it('matches `src/**/*.ts` directly inside src and deeper', () => {
    expect(applies('src/**/*.ts', 'src/index.ts')).toBe(true);
    expect(applies('src/**/*.ts', 'src/lib/util.ts')).toBe(true);
    expect(applies('src/**/*.ts', 'lib/index.ts')).toBe(false);
    expect(applies('src/**/*.ts', 'srcx/index.ts')).toBe(false);
  });

  it('keeps `**/` anchored to a path segment', () => {
    expect(applies('**/test.py', 'test.py')).toBe(true);
    expect(applies('**/test.py', 'pkg/test.py')).toBe(true);
    expect(applies('**/test.py', 'mytest.py')).toBe(false);
    expect(applies('**/test.py', 'pkg/mytest.py')).toBe(false);
  });

  it('keeps `*` within one path segment', () => {
    expect(applies('*.ts', 'index.ts')).toBe(true);
    expect(applies('*.ts', 'src/index.ts')).toBe(false);
    expect(applies('src/*.ts', 'src/lib/util.ts')).toBe(false);
  });

  it('keeps a trailing `**` matching everything below a directory', () => {
    expect(applies('docs/**', 'docs/a.md')).toBe(true);
    expect(applies('docs/**', 'docs/x/y/a.md')).toBe(true);
    expect(applies('docs/**', 'src/a.md')).toBe(false);
  });

  // Regex metacharacters in a glob are literal path characters (Next.js route
  // groups, C++ sources). They must neither change the match nor throw.
  it('treats regex metacharacters as literal characters', () => {
    expect(applies('app/(auth)/**', 'app/(auth)/page.tsx')).toBe(true);
    expect(applies('app/(auth)/**', 'app/auth/page.tsx')).toBe(false);
  });

  it('does not throw on a glob that is not a valid regex', () => {
    expect(applies('**/*.c++', 'src/main.c++')).toBe(true);
    expect(applies('**/*.c++', 'src/main.cc')).toBe(false);
    expect(() => applies('src/[broken', 'src/broken')).not.toThrow();
  });

  it('treats a backslash-escaped character as literal', () => {
    expect(applies('app/\\(auth\\)/**', 'app/(auth)/page.tsx')).toBe(true);
    expect(applies('a\\*b.ts', 'a*b.ts')).toBe(true);
    expect(applies('a\\*b.ts', 'axb.ts')).toBe(false);
  });

  it('keeps `[...]` as a character class', () => {
    expect(applies('lib/[ab].ts', 'lib/a.ts')).toBe(true);
    expect(applies('lib/[ab].ts', 'lib/c.ts')).toBe(false);
    expect(applies('lib/[^ab].ts', 'lib/c.ts')).toBe(true);
    expect(applies('lib/[^ab].ts', 'lib/a.ts')).toBe(false);
    expect(applies('lib/[*].ts', 'lib/*.ts')).toBe(true);
  });

  it('expands `{a,b}` brace alternation', () => {
    expect(applies('**/*.{ts,tsx}', 'src/a/b.tsx')).toBe(true);
    expect(applies('**/*.{ts,tsx}', 'main.ts')).toBe(true);
    expect(applies('**/*.{ts,tsx}', 'src/a/b.js')).toBe(false);
    expect(applies('{src,lib}/**/*.py', 'lib/x/y.py')).toBe(true);
    expect(applies('{src,lib}/**/*.py', 'test/x/y.py')).toBe(false);
  });

  it('supports nested and multiple brace groups', () => {
    expect(applies('src/*.{ts,{js,mjs}}', 'src/a.mjs')).toBe(true);
    expect(applies('{a,b}/{x,y}.ts', 'b/x.ts')).toBe(true);
    expect(applies('{a,b}/{x,y}.ts', 'c/x.ts')).toBe(false);
  });

  it('supports empty brace alternatives', () => {
    expect(applies('src/file{,.ts}', 'src/file')).toBe(true);
    expect(applies('src/file{,.ts}', 'src/file.ts')).toBe(true);
    expect(applies('src/*.{ts,tsx,}', 'src/index.')).toBe(true);
    expect(applies('src/*.{ts,tsx,}', 'src/index.js')).toBe(false);
  });

  it('keeps regex anchors literal inside brace alternatives', () => {
    expect(applies('{^README.md,other.md}', 'README.md')).toBe(false);
    expect(applies('{^README.md,other.md}', '^README.md')).toBe(true);
  });

  it('bounds expansion depth for pathological numbers of brace groups', () => {
    const pattern = '{a,b}'.repeat(10_000);
    expect(() => applies(pattern, 'a'.repeat(10_000))).not.toThrow();
    expect(applies(pattern, 'a'.repeat(10_000))).toBe(false);

    const nestedPattern = `${'{'.repeat(10_000)}a,b${'}'.repeat(10_000)}`;
    expect(() => applies(nestedPattern, 'a')).not.toThrow();
    expect(applies(nestedPattern, 'a')).toBe(false);
  });

  it('keeps a brace group without a comma or closing brace literal', () => {
    expect(applies('app/{id}/page.tsx', 'app/{id}/page.tsx')).toBe(true);
    expect(applies('app/{id}/page.tsx', 'app/id/page.tsx')).toBe(false);
    expect(applies('a{b.ts', 'a{b.ts')).toBe(true);
  });

  it('keeps a backslash-escaped brace literal', () => {
    expect(applies('a\\{b,c}.ts', 'a{b,c}.ts')).toBe(true);
    expect(applies('a\\{b,c}.ts', 'ab.ts')).toBe(false);
    expect(applies(String.raw`fixtures/\{a,b\}.json`, 'fixtures/{a,b}.json')).toBe(true);
    expect(applies(String.raw`fixtures/\{a,b\}.json`, 'fixtures/a.json')).toBe(false);
  });
});
