import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatLocation, formatWorkspaceEdit, uriToPath } from '../utils.js';

const fixtures: string[] = [];
afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('native local file URI paths', () => {
  it('resolves localhost URI results to the actual file for location and edit previews', () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-lsp-uri-'));
    fixtures.push(directory);
    const source = join(directory, '日本語 # %.ts');
    writeFileSync(source, 'const original = true;');
    const nativeUri = pathToFileURL(source);
    const uri = `file://localhost${nativeUri.pathname}`;
    expect(uriToPath(uri)).toBe(source);
    expect(readFileSync(uriToPath(uri), 'utf8')).toBe('const original = true;');
    const range = { start: { line: 0, character: 6 }, end: { line: 0, character: 14 } };
    expect(formatLocation({ uri, range })).toBe(`${source}:1:7-1:15`);
    expect(formatWorkspaceEdit({ changes: { [uri]: [{ range, newText: 'replacement' }] } }))
      .toContain(`File: ${source}`);
  });

  it('keeps native path roundtrips and malformed/non-file fallbacks', () => {
    const source = join(tmpdir(), 'ordinary file.ts');
    expect(uriToPath(pathToFileURL(source).href)).toBe(source);
    expect(uriToPath('file:///bad%escape.ts')).toBe('/bad%escape.ts');
    expect(uriToPath('https://example.com/file.ts')).toBe('https://example.com/file.ts');
    expect(uriToPath('untitled:Untitled-1')).toBe('untitled:Untitled-1');
  });
});
