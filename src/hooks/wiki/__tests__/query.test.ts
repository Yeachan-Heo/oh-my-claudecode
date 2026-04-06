/**
 * Tests for Wiki Query
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { queryWiki } from '../query.js';
import { writePage, ensureWikiDir } from '../storage.js';
import { WIKI_SCHEMA_VERSION } from '../types.js';
import type { WikiPage } from '../types.js';

function makePage(filename: string, opts: {
  title?: string;
  tags?: string[];
  category?: string;
  content?: string;
  confidence?: string;
} = {}): WikiPage {
  return {
    filename,
    frontmatter: {
      title: opts.title || filename.replace('.md', ''),
      tags: opts.tags || [],
      created: '2025-01-01T00:00:00.000Z',
      updated: '2025-01-01T00:00:00.000Z',
      sources: [],
      links: [],
      category: (opts.category || 'reference') as WikiPage['frontmatter']['category'],
      confidence: (opts.confidence || 'medium') as WikiPage['frontmatter']['confidence'],
      schemaVersion: WIKI_SCHEMA_VERSION,
    },
    content: opts.content || `\n# ${opts.title || filename}\n\nDefault content.\n`,
  };
}

describe('Wiki Query', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wiki-query-test-'));
    ensureWikiDir(tempDir);
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('should return empty for empty wiki', () => {
    const results = queryWiki(tempDir, 'anything');
    expect(results).toEqual([]);
  });

  it('should match by title', () => {
    writePage(tempDir, makePage('auth.md', { title: 'Authentication Flow', tags: ['auth'] }));
    writePage(tempDir, makePage('db.md', { title: 'Database Schema', tags: ['db'] }));

    const results = queryWiki(tempDir, 'authentication');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].page.filename).toBe('auth.md');
  });

  it('should match by content', () => {
    writePage(tempDir, makePage('page.md', {
      title: 'Unrelated Title',
      content: '\n# Something\n\nThis page describes JWT token validation.\n',
    }));

    const results = queryWiki(tempDir, 'JWT');
    expect(results.length).toBe(1);
    expect(results[0].snippet).toContain('JWT');
  });

  it('should match by tags', () => {
    writePage(tempDir, makePage('tagged.md', { title: 'Tagged Page', tags: ['security', 'auth'] }));
    writePage(tempDir, makePage('untagged.md', { title: 'Untagged' }));

    const results = queryWiki(tempDir, 'anything', { tags: ['security'] });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].page.filename).toBe('tagged.md');
  });

  it('should filter by category', () => {
    writePage(tempDir, makePage('arch.md', { title: 'Architecture', category: 'architecture' }));
    writePage(tempDir, makePage('debug.md', { title: 'Debug Info', category: 'debugging' }));

    const results = queryWiki(tempDir, 'info', { category: 'debugging' });
    // Should only return debugging category
    for (const r of results) {
      expect(r.page.frontmatter.category).toBe('debugging');
    }
  });

  it('should respect limit', () => {
    for (let i = 0; i < 5; i++) {
      writePage(tempDir, makePage(`page-${i}.md`, {
        title: `Test Page ${i}`,
        tags: ['common'],
        content: `\n# Page ${i}\n\nCommon keyword here.\n`,
      }));
    }

    const results = queryWiki(tempDir, 'common', { limit: 2 });
    expect(results.length).toBe(2);
  });

  it('should sort by score descending', () => {
    writePage(tempDir, makePage('low.md', {
      title: 'Unrelated',
      content: '\n# Low\n\nContains auth once.\n',
    }));
    writePage(tempDir, makePage('high.md', {
      title: 'Auth Architecture',
      tags: ['auth'],
      content: '\n# Auth\n\nFull auth documentation.\n',
    }));

    const results = queryWiki(tempDir, 'auth');
    expect(results.length).toBe(2);
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
    expect(results[0].page.filename).toBe('high.md');
  });

  it('should provide snippets', () => {
    writePage(tempDir, makePage('snippet.md', {
      title: 'Snippet Test',
      content: '\n# Snippet\n\nSome text before the keyword. Important keyword here with context after.\n',
    }));

    const results = queryWiki(tempDir, 'keyword');
    expect(results.length).toBe(1);
    expect(results[0].snippet.length).toBeGreaterThan(0);
  });

  it('should match query terms against page tags', () => {
    writePage(tempDir, makePage('tagged.md', {
      title: 'No Match Title',
      tags: ['authentication', 'security'],
      content: '\n# Nothing\n\nNo query terms in content.\n',
    }));

    const results = queryWiki(tempDir, 'authentication');
    expect(results.length).toBe(1);
    expect(results[0].score).toBeGreaterThan(0);
  });
});
