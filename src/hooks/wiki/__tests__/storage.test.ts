/**
 * Tests for Wiki Storage
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  getWikiDir,
  ensureWikiDir,
  parseFrontmatter,
  serializePage,
  readPage,
  listPages,
  readAllPages,
  readIndex,
  readLog,
  writePage,
  deletePage,
  appendLog,
  titleToSlug,
  withWikiLock,
  updateIndexUnsafe,
} from '../storage.js';
import { WIKI_SCHEMA_VERSION } from '../types.js';
import type { WikiPage } from '../types.js';

function makePage(overrides: Partial<WikiPage> = {}): WikiPage {
  return {
    filename: 'test-page.md',
    frontmatter: {
      title: 'Test Page',
      tags: ['test'],
      created: '2025-01-01T00:00:00.000Z',
      updated: '2025-01-01T00:00:00.000Z',
      sources: [],
      links: [],
      category: 'reference',
      confidence: 'medium',
      schemaVersion: WIKI_SCHEMA_VERSION,
    },
    content: '\n# Test Page\n\nSome content here.\n',
    ...overrides,
  };
}

describe('Wiki Storage', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wiki-storage-test-'));
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  describe('getWikiDir', () => {
    it('should return .omc/wiki path', () => {
      const dir = getWikiDir(tempDir);
      expect(dir).toBe(path.join(tempDir, '.omc', 'wiki'));
    });
  });

  describe('ensureWikiDir', () => {
    it('should create wiki directory', () => {
      const dir = ensureWikiDir(tempDir);
      expect(fs.existsSync(dir)).toBe(true);
    });

    it('should create .gitignore with wiki/ entry', () => {
      ensureWikiDir(tempDir);
      const gitignorePath = path.join(tempDir, '.omc', '.gitignore');
      expect(fs.existsSync(gitignorePath)).toBe(true);
      expect(fs.readFileSync(gitignorePath, 'utf-8')).toContain('wiki/');
    });

    it('should append to existing .gitignore', () => {
      const omcDir = path.join(tempDir, '.omc');
      fs.mkdirSync(omcDir, { recursive: true });
      fs.writeFileSync(path.join(omcDir, '.gitignore'), 'state/\n');

      ensureWikiDir(tempDir);
      const content = fs.readFileSync(path.join(omcDir, '.gitignore'), 'utf-8');
      expect(content).toContain('state/');
      expect(content).toContain('wiki/');
    });

    it('should not duplicate wiki/ in .gitignore', () => {
      const omcDir = path.join(tempDir, '.omc');
      fs.mkdirSync(omcDir, { recursive: true });
      fs.writeFileSync(path.join(omcDir, '.gitignore'), 'wiki/\n');

      ensureWikiDir(tempDir);
      const content = fs.readFileSync(path.join(omcDir, '.gitignore'), 'utf-8');
      const matches = content.match(/wiki\//g);
      expect(matches?.length).toBe(1);
    });
  });

  describe('titleToSlug', () => {
    it('should convert title to lowercase slug with .md', () => {
      expect(titleToSlug('Auth Architecture')).toBe('auth-architecture.md');
    });

    it('should strip special characters', () => {
      expect(titleToSlug('Hello, World!')).toBe('hello-world.md');
    });

    it('should truncate long slugs', () => {
      const longTitle = 'a'.repeat(100);
      const slug = titleToSlug(longTitle);
      // 64 chars + .md = 67
      expect(slug.length).toBeLessThanOrEqual(67);
    });

    it('should strip leading/trailing hyphens', () => {
      expect(titleToSlug('---test---')).toBe('test.md');
    });
  });

  describe('parseFrontmatter', () => {
    it('should parse valid frontmatter', () => {
      const raw = `---
title: "Test Page"
tags: ["tag1", "tag2"]
created: 2025-01-01T00:00:00.000Z
updated: 2025-01-01T00:00:00.000Z
sources: []
links: []
category: reference
confidence: medium
schemaVersion: 1
---
# Content here`;

      const result = parseFrontmatter(raw);
      expect(result).not.toBeNull();
      expect(result!.frontmatter.title).toBe('Test Page');
      expect(result!.frontmatter.tags).toEqual(['tag1', 'tag2']);
      expect(result!.frontmatter.category).toBe('reference');
      expect(result!.content).toBe('# Content here');
    });

    it('should return null for invalid frontmatter', () => {
      expect(parseFrontmatter('no frontmatter here')).toBeNull();
    });

    it('should return null for missing --- delimiters', () => {
      expect(parseFrontmatter('---\ntitle: test')).toBeNull();
    });
  });

  describe('serializePage + parseFrontmatter roundtrip', () => {
    it('should roundtrip a page', () => {
      const page = makePage();
      const serialized = serializePage(page);
      const parsed = parseFrontmatter(serialized);

      expect(parsed).not.toBeNull();
      expect(parsed!.frontmatter.category).toBe(page.frontmatter.category);
      expect(parsed!.frontmatter.confidence).toBe(page.frontmatter.confidence);
      expect(parsed!.content).toBe(page.content);
    });

    it('should handle titles with quotes', () => {
      const page = makePage({
        frontmatter: {
          ...makePage().frontmatter,
          title: 'My "Special" Page',
        },
      });
      const serialized = serializePage(page);
      const parsed = parseFrontmatter(serialized);

      expect(parsed).not.toBeNull();
      expect(parsed!.frontmatter.title).toBe('My "Special" Page');
    });
  });

  describe('writePage + readPage', () => {
    it('should write and read a page', () => {
      const page = makePage();
      writePage(tempDir, page);

      const read = readPage(tempDir, 'test-page.md');
      expect(read).not.toBeNull();
      expect(read!.frontmatter.category).toBe('reference');
      expect(read!.content).toContain('Some content here');
    });

    it('should return null for non-existent page', () => {
      ensureWikiDir(tempDir);
      expect(readPage(tempDir, 'non-existent.md')).toBeNull();
    });

    it('should reject path traversal in readPage', () => {
      ensureWikiDir(tempDir);
      expect(readPage(tempDir, '../../etc/passwd')).toBeNull();
      expect(readPage(tempDir, '../.env')).toBeNull();
      expect(readPage(tempDir, 'foo/../../bar.md')).toBeNull();
    });

    it('should reject path traversal in deletePage', () => {
      ensureWikiDir(tempDir);
      expect(deletePage(tempDir, '../../etc/passwd')).toBe(false);
      expect(deletePage(tempDir, '../important.txt')).toBe(false);
    });

    it('should reject path traversal in writePage', () => {
      expect(() => {
        writePage(tempDir, makePage({ filename: '../../evil.md' }));
      }).toThrow('Invalid wiki page filename');
    });
  });

  describe('listPages', () => {
    it('should list page files excluding index.md and log.md', () => {
      ensureWikiDir(tempDir);
      const wikiDir = getWikiDir(tempDir);

      fs.writeFileSync(path.join(wikiDir, 'page-a.md'), '---\ntitle: A\n---\ncontent');
      fs.writeFileSync(path.join(wikiDir, 'page-b.md'), '---\ntitle: B\n---\ncontent');
      fs.writeFileSync(path.join(wikiDir, 'index.md'), '# Index');
      fs.writeFileSync(path.join(wikiDir, 'log.md'), '# Log');

      const pages = listPages(tempDir);
      expect(pages).toEqual(['page-a.md', 'page-b.md']);
    });

    it('should return empty for non-existent wiki dir', () => {
      expect(listPages(tempDir)).toEqual([]);
    });
  });

  describe('readAllPages', () => {
    it('should read all valid pages', () => {
      writePage(tempDir, makePage({ filename: 'page-1.md' }));
      writePage(tempDir, makePage({
        filename: 'page-2.md',
        frontmatter: {
          ...makePage().frontmatter,
          title: 'Page 2',
          category: 'architecture',
        },
      }));

      const pages = readAllPages(tempDir);
      expect(pages.length).toBe(2);
    });
  });

  describe('deletePage', () => {
    it('should delete an existing page', () => {
      writePage(tempDir, makePage());
      const result = deletePage(tempDir, 'test-page.md');
      expect(result).toBe(true);
      expect(readPage(tempDir, 'test-page.md')).toBeNull();
    });

    it('should return false for non-existent page', () => {
      ensureWikiDir(tempDir);
      expect(deletePage(tempDir, 'non-existent.md')).toBe(false);
    });
  });

  describe('appendLog', () => {
    it('should create log file on first append', () => {
      ensureWikiDir(tempDir);
      appendLog(tempDir, {
        timestamp: '2025-01-01T00:00:00.000Z',
        operation: 'add',
        pagesAffected: ['test.md'],
        summary: 'Added test page',
      });

      const log = readLog(tempDir);
      expect(log).not.toBeNull();
      expect(log).toContain('Added test page');
      expect(log).toContain('# Wiki Log');
    });

    it('should append to existing log', () => {
      ensureWikiDir(tempDir);
      appendLog(tempDir, {
        timestamp: '2025-01-01T00:00:00.000Z',
        operation: 'add',
        pagesAffected: ['a.md'],
        summary: 'First entry',
      });
      appendLog(tempDir, {
        timestamp: '2025-01-02T00:00:00.000Z',
        operation: 'delete',
        pagesAffected: ['b.md'],
        summary: 'Second entry',
      });

      const log = readLog(tempDir);
      expect(log).toContain('First entry');
      expect(log).toContain('Second entry');
    });
  });

  describe('updateIndexUnsafe', () => {
    it('should generate index grouped by category', () => {
      writePage(tempDir, makePage({
        filename: 'arch.md',
        frontmatter: { ...makePage().frontmatter, title: 'Arch', category: 'architecture' },
      }));
      writePage(tempDir, makePage({
        filename: 'ref.md',
        frontmatter: { ...makePage().frontmatter, title: 'Ref', category: 'reference' },
      }));

      withWikiLock(tempDir, () => { updateIndexUnsafe(tempDir); });

      const index = readIndex(tempDir);
      expect(index).not.toBeNull();
      expect(index).toContain('## architecture');
      expect(index).toContain('## reference');
      expect(index).toContain('[Arch](arch.md)');
      expect(index).toContain('[Ref](ref.md)');
    });
  });

  describe('withWikiLock', () => {
    it('should return value from callback', () => {
      const result = withWikiLock(tempDir, () => 42);
      expect(result).toBe(42);
    });

    it('should propagate errors from callback', () => {
      expect(() => {
        withWikiLock(tempDir, () => { throw new Error('test error'); });
      }).toThrow('test error');
    });
  });
});
