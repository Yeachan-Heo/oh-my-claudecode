/**
 * Tests for session-log TTL and auto-GC.
 *
 * Session-log pages are auto-captured at session end but accumulate
 * without bound. This adds a 7-day TTL so they auto-expire, and a
 * GC pass at session start to clean them up.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  parseFrontmatter,
  serializePage,
  writePage,
  readPage,
  readAllPages,
  ensureWikiDir,
  isPageExpired,
  cleanupExpiredPages,
} from '../storage.js';
import { ingestKnowledge } from '../ingest.js';
import { WIKI_SCHEMA_VERSION, CATEGORY_DEFAULT_TTL } from '../types.js';
import type { WikiPage } from '../types.js';

function makePage(filename: string, overrides: Partial<WikiPage['frontmatter']> = {}): WikiPage {
  return {
    filename,
    frontmatter: {
      title: filename.replace('.md', ''),
      tags: ['test'],
      created: '2025-01-01T00:00:00.000Z',
      updated: '2025-01-01T00:00:00.000Z',
      sources: [],
      links: [],
      category: 'reference',
      confidence: 'medium',
      schemaVersion: WIKI_SCHEMA_VERSION,
      ...overrides,
    },
    content: '\n# Test\n\nContent.\n',
  };
}

describe('TTL frontmatter', () => {
  it('should serialize ttl and expiresAt', () => {
    const page = makePage('ttl.md', {
      ttl: 3600,
      expiresAt: '2025-06-01T00:00:00.000Z',
    });
    const raw = serializePage(page);
    expect(raw).toContain('ttl: 3600');
    expect(raw).toContain('expiresAt: 2025-06-01T00:00:00.000Z');
  });

  it('should parse ttl and expiresAt', () => {
    const page = makePage('ttl.md', {
      ttl: 7200,
      expiresAt: '2025-07-01T00:00:00.000Z',
    });
    const raw = serializePage(page);
    const parsed = parseFrontmatter(raw);
    expect(parsed!.frontmatter.ttl).toBe(7200);
    expect(parsed!.frontmatter.expiresAt).toBe('2025-07-01T00:00:00.000Z');
  });

  it('should not serialize ttl/expiresAt when absent', () => {
    const page = makePage('no-ttl.md');
    const raw = serializePage(page);
    expect(raw).not.toContain('ttl:');
    expect(raw).not.toContain('expiresAt:');
  });
});

describe('isPageExpired', () => {
  it('returns false when no expiresAt', () => {
    expect(isPageExpired(makePage('a.md'))).toBe(false);
  });

  it('returns false for future expiresAt', () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    expect(isPageExpired(makePage('b.md', { expiresAt: future }))).toBe(false);
  });

  it('returns true for past expiresAt', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect(isPageExpired(makePage('c.md', { expiresAt: past }))).toBe(true);
  });
});

describe('cleanupExpiredPages', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wiki-gc-test-'));
    ensureWikiDir(tempDir);
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('should remove expired pages', () => {
    writePage(tempDir, makePage('expired.md', {
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }));
    writePage(tempDir, makePage('valid.md'));

    expect(readAllPages(tempDir)).toHaveLength(2);
    const result = cleanupExpiredPages(tempDir);
    expect(result.removed).toBe(1);
    expect(result.filenames).toContain('expired.md');
    expect(readAllPages(tempDir)).toHaveLength(1);
  });

  it('should return 0 when nothing expired', () => {
    writePage(tempDir, makePage('alive.md'));
    expect(cleanupExpiredPages(tempDir).removed).toBe(0);
  });
});

describe('session-log category defaults', () => {
  it('should have 7-day TTL', () => {
    expect(CATEGORY_DEFAULT_TTL['session-log']).toBe(7 * 24 * 60 * 60);
  });

  it('architecture should have no default TTL', () => {
    expect(CATEGORY_DEFAULT_TTL['architecture']).toBeUndefined();
  });
});

describe('ingest applies category TTL', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wiki-ttl-ingest-'));
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('session-log ingest should auto-apply 7-day TTL', () => {
    const result = ingestKnowledge(tempDir, {
      title: 'Session Log Test',
      content: 'Auto-captured.',
      tags: ['session-log'],
      category: 'session-log',
    });

    const page = readPage(tempDir, result.created[0]);
    expect(page!.frontmatter.ttl).toBe(7 * 24 * 60 * 60);
    expect(page!.frontmatter.expiresAt).toBeDefined();

    const expiresAt = new Date(page!.frontmatter.expiresAt!).getTime();
    const sevenDays = Date.now() + 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(expiresAt - sevenDays)).toBeLessThan(5000);
  });

  it('architecture ingest should NOT apply TTL', () => {
    const result = ingestKnowledge(tempDir, {
      title: 'Arch Test',
      content: 'Permanent.',
      tags: ['arch'],
      category: 'architecture',
    });

    const page = readPage(tempDir, result.created[0]);
    expect(page!.frontmatter.ttl).toBeUndefined();
    expect(page!.frontmatter.expiresAt).toBeUndefined();
  });

  it('explicit ttl should override category default', () => {
    const result = ingestKnowledge(tempDir, {
      title: 'Custom TTL',
      content: 'Short-lived.',
      tags: ['test'],
      category: 'session-log',
      ttl: 3600, // 1 hour, not 7 days
    });

    const page = readPage(tempDir, result.created[0]);
    expect(page!.frontmatter.ttl).toBe(3600);
  });
});
