import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { writePageUnsafe, ensureWikiDir, withWikiLock } from '../storage.js';
import { WIKI_SCHEMA_VERSION } from '../types.js';
import type { WikiPage } from '../types.js';
import { writeEnvironmentUnsafe, readPage } from '../storage.js';

function makePage(filename: string): WikiPage {
  return {
    filename,
    frontmatter: {
      title: 'Test', tags: [], created: '2025-01-01T00:00:00.000Z',
      updated: '2025-01-01T00:00:00.000Z', sources: [], links: [],
      category: 'reference', confidence: 'medium', schemaVersion: WIKI_SCHEMA_VERSION,
    },
    content: '\n# Test\n\nContent.\n',
  };
}

describe('writePageUnsafe reserved file guard', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wiki-guard-'));
    ensureWikiDir(tempDir);
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('should throw when writing to index.md', () => {
    expect(() => {
      withWikiLock(tempDir, () => writePageUnsafe(tempDir, makePage('index.md')));
    }).toThrow('Cannot write to reserved wiki file');
  });

  it('should throw when writing to log.md', () => {
    expect(() => {
      withWikiLock(tempDir, () => writePageUnsafe(tempDir, makePage('log.md')));
    }).toThrow('Cannot write to reserved wiki file');
  });

  it('should allow non-reserved filenames', () => {
    expect(() => {
      withWikiLock(tempDir, () => writePageUnsafe(tempDir, makePage('auth.md')));
    }).not.toThrow();
  });
  it('should throw when writing to environment.md via writePageUnsafe', () => {
    expect(() => {
      withWikiLock(tempDir, () => writePageUnsafe(tempDir, makePage('environment.md')));
    }).toThrow('Cannot write to reserved wiki file');
  });

  it('writeEnvironmentUnsafe bypasses the reserved guard for environment.md', () => {
    expect(() => {
      withWikiLock(tempDir, () => writeEnvironmentUnsafe(tempDir, makePage('environment.md')));
    }).not.toThrow();
    expect(readPage(tempDir, 'environment.md')?.frontmatter.title).toBe('Test');
  });
});
