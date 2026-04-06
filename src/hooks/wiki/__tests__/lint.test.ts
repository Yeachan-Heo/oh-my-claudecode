/**
 * Tests for Wiki Lint
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { lintWiki } from '../lint.js';
import { writePage, ensureWikiDir } from '../storage.js';
import { WIKI_SCHEMA_VERSION } from '../types.js';
import type { WikiPage } from '../types.js';

function makePage(filename: string, opts: {
  title?: string;
  tags?: string[];
  category?: string;
  confidence?: string;
  links?: string[];
  updated?: string;
  content?: string;
} = {}): WikiPage {
  return {
    filename,
    frontmatter: {
      title: opts.title || filename.replace('.md', ''),
      tags: opts.tags || [],
      created: '2025-01-01T00:00:00.000Z',
      updated: opts.updated || new Date().toISOString(),
      sources: [],
      links: opts.links || [],
      category: (opts.category || 'reference') as WikiPage['frontmatter']['category'],
      confidence: (opts.confidence || 'medium') as WikiPage['frontmatter']['confidence'],
      schemaVersion: WIKI_SCHEMA_VERSION,
    },
    content: opts.content || `\n# ${opts.title || filename}\n\nContent.\n`,
  };
}

describe('Wiki Lint', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wiki-lint-test-'));
    ensureWikiDir(tempDir);
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('should return no issues for empty wiki', () => {
    const report = lintWiki(tempDir);
    expect(report.issues).toEqual([]);
    expect(report.stats.totalPages).toBe(0);
  });

  describe('orphan detection', () => {
    it('should detect orphan pages (no incoming links)', () => {
      writePage(tempDir, makePage('orphan.md', { title: 'Orphan Page' }));

      const report = lintWiki(tempDir);
      expect(report.stats.orphanCount).toBeGreaterThanOrEqual(1);
      const orphanIssue = report.issues.find(i => i.type === 'orphan' && i.page === 'orphan.md');
      expect(orphanIssue).toBeDefined();
    });

    it('should not flag pages with incoming links as orphans', () => {
      writePage(tempDir, makePage('target.md', { title: 'Target' }));
      writePage(tempDir, makePage('source.md', { title: 'Source', links: ['target.md'] }));

      const report = lintWiki(tempDir);
      const targetOrphan = report.issues.find(i => i.type === 'orphan' && i.page === 'target.md');
      expect(targetOrphan).toBeUndefined();
    });
  });

  describe('stale detection', () => {
    it('should detect stale pages', () => {
      const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 days ago
      writePage(tempDir, makePage('stale.md', { title: 'Stale', updated: oldDate }));

      const report = lintWiki(tempDir);
      expect(report.stats.staleCount).toBeGreaterThanOrEqual(1);
    });

    it('should not flag recent pages as stale', () => {
      writePage(tempDir, makePage('fresh.md', { title: 'Fresh', updated: new Date().toISOString() }));

      const report = lintWiki(tempDir);
      const staleIssue = report.issues.find(i => i.type === 'stale' && i.page === 'fresh.md');
      expect(staleIssue).toBeUndefined();
    });
  });

  describe('broken cross-references', () => {
    it('should detect links to non-existent pages', () => {
      writePage(tempDir, makePage('linker.md', {
        title: 'Linker',
        links: ['non-existent.md'],
      }));

      const report = lintWiki(tempDir);
      expect(report.stats.brokenRefCount).toBeGreaterThanOrEqual(1);
      const brokenRef = report.issues.find(i => i.type === 'broken-ref');
      expect(brokenRef).toBeDefined();
      expect(brokenRef!.message).toContain('non-existent.md');
    });

    it('should not flag valid links', () => {
      writePage(tempDir, makePage('target.md', { title: 'Target' }));
      writePage(tempDir, makePage('source.md', { title: 'Source', links: ['target.md'] }));

      const report = lintWiki(tempDir);
      expect(report.stats.brokenRefCount).toBe(0);
    });
  });

  describe('low confidence', () => {
    it('should flag low confidence pages', () => {
      writePage(tempDir, makePage('low.md', { title: 'Low', confidence: 'low' }));

      const report = lintWiki(tempDir);
      const lowConf = report.issues.find(i => i.type === 'low-confidence');
      expect(lowConf).toBeDefined();
    });
  });

  describe('oversized pages', () => {
    it('should flag pages exceeding max size', () => {
      const bigContent = 'x'.repeat(15_000);
      writePage(tempDir, makePage('big.md', { title: 'Big', content: bigContent }));

      const report = lintWiki(tempDir);
      expect(report.stats.oversizedCount).toBeGreaterThanOrEqual(1);
    });

    it('should not flag normal-sized pages', () => {
      writePage(tempDir, makePage('small.md', { title: 'Small', content: 'Short content.' }));

      const report = lintWiki(tempDir);
      expect(report.stats.oversizedCount).toBe(0);
    });
  });

  describe('structural contradictions', () => {
    it('should detect conflicting confidence in related pages', () => {
      // Slug prefix grouping uses first 2 hyphen-separated segments
      // auth-impl-flow → prefix "auth-impl", auth-impl-tokens → prefix "auth-impl"
      writePage(tempDir, makePage('auth-impl-flow.md', {
        title: 'Auth Impl Flow',
        tags: ['auth'],
        category: 'architecture',
        confidence: 'high',
      }));
      writePage(tempDir, makePage('auth-impl-tokens.md', {
        title: 'Auth Impl Tokens',
        tags: ['auth'],
        category: 'architecture',
        confidence: 'low',
      }));

      const report = lintWiki(tempDir);
      expect(report.stats.contradictionCount).toBeGreaterThanOrEqual(1);
    });

    it('should detect tags appearing in different categories', () => {
      // Same 2-segment prefix: "db-ops" groups these together
      writePage(tempDir, makePage('db-ops-schema.md', {
        title: 'DB Ops Schema',
        tags: ['database'],
        category: 'architecture',
      }));
      writePage(tempDir, makePage('db-ops-debug.md', {
        title: 'DB Ops Debug',
        tags: ['database'],
        category: 'debugging',
      }));

      const report = lintWiki(tempDir);
      const tagContra = report.issues.find(i =>
        i.type === 'structural-contradiction' && i.message.includes('database')
      );
      expect(tagContra).toBeDefined();
    });
  });

  describe('stats summary', () => {
    it('should provide complete stats', () => {
      writePage(tempDir, makePage('page.md', { title: 'Page' }));

      const report = lintWiki(tempDir);
      expect(report.stats).toHaveProperty('totalPages');
      expect(report.stats).toHaveProperty('orphanCount');
      expect(report.stats).toHaveProperty('staleCount');
      expect(report.stats).toHaveProperty('brokenRefCount');
      expect(report.stats).toHaveProperty('lowConfidenceCount');
      expect(report.stats).toHaveProperty('oversizedCount');
      expect(report.stats).toHaveProperty('contradictionCount');
    });
  });
});
