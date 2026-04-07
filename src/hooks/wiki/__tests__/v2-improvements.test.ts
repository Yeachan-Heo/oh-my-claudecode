/**
 * Tests for Wiki v2 Improvements
 *
 * - TTL & auto-GC
 * - Compaction
 * - 2-tier storage (global + local)
 * - CJK tokenization
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
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
  countAppendSections,
  compactPage,
  compactAllPages,
  getGlobalWikiDir,
  ensureGlobalWikiDir,
  readAllGlobalPages,
  writeGlobalPage,
  deleteGlobalPage,
} from '../storage.js';
import { ingestKnowledge } from '../ingest.js';
import { queryWiki, tokenize } from '../query.js';
import {
  WIKI_SCHEMA_VERSION,
  CATEGORY_DEFAULT_TTL,
  COMPACTION_THRESHOLD,
  COMPACTION_KEEP_RECENT,
  GLOBAL_SCOPE_CATEGORIES,
} from '../types.js';
import type { WikiPage } from '../types.js';

function makePage(filename: string, overrides: Partial<WikiPage['frontmatter']> = {}, content?: string): WikiPage {
  return {
    filename,
    frontmatter: {
      title: filename.replace('.md', '').replace(/-/g, ' '),
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
    content: content || `\n# Test\n\nSome content.\n`,
  };
}

// ============================================================================
// TTL & GC Tests
// ============================================================================

describe('TTL & Garbage Collection', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wiki-gc-test-'));
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('should serialize and parse ttl/expiresAt fields', () => {
    const page = makePage('ttl-page.md', {
      ttl: 3600,
      expiresAt: '2025-06-01T00:00:00.000Z',
    });

    const serialized = serializePage(page);
    expect(serialized).toContain('ttl: 3600');
    expect(serialized).toContain('expiresAt: 2025-06-01T00:00:00.000Z');

    const parsed = parseFrontmatter(serialized);
    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter.ttl).toBe(3600);
    expect(parsed!.frontmatter.expiresAt).toBe('2025-06-01T00:00:00.000Z');
  });

  it('should not serialize optional fields when absent', () => {
    const page = makePage('no-ttl.md');
    const serialized = serializePage(page);
    expect(serialized).not.toContain('ttl:');
    expect(serialized).not.toContain('expiresAt:');
    expect(serialized).not.toContain('compactedAt:');
    expect(serialized).not.toContain('scope:');
  });

  it('isPageExpired should return false when no expiresAt', () => {
    const page = makePage('no-expiry.md');
    expect(isPageExpired(page)).toBe(false);
  });

  it('isPageExpired should return false for future expiresAt', () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    const page = makePage('future.md', { expiresAt: future });
    expect(isPageExpired(page)).toBe(false);
  });

  it('isPageExpired should return true for past expiresAt', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const page = makePage('expired.md', { expiresAt: past });
    expect(isPageExpired(page)).toBe(true);
  });

  it('cleanupExpiredPages should remove expired pages', () => {
    ensureWikiDir(tempDir);

    // Write one expired and one non-expired page
    const expired = makePage('expired.md', {
      ttl: 1,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const valid = makePage('valid.md');

    writePage(tempDir, expired);
    writePage(tempDir, valid);

    expect(readAllPages(tempDir)).toHaveLength(2);

    const result = cleanupExpiredPages(tempDir);
    expect(result.removed).toBe(1);
    expect(result.filenames).toContain('expired.md');

    const remaining = readAllPages(tempDir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].filename).toBe('valid.md');
  });

  it('cleanupExpiredPages should return 0 when nothing expired', () => {
    ensureWikiDir(tempDir);
    writePage(tempDir, makePage('alive.md'));
    const result = cleanupExpiredPages(tempDir);
    expect(result.removed).toBe(0);
  });

  it('session-log category should have default TTL of 7 days', () => {
    expect(CATEGORY_DEFAULT_TTL['session-log']).toBe(7 * 24 * 60 * 60);
  });

  it('ingest with session-log category should auto-apply TTL', () => {
    const result = ingestKnowledge(tempDir, {
      title: 'Session Log Test',
      content: 'Test session log.',
      tags: ['session-log'],
      category: 'session-log',
    });

    const page = readPage(tempDir, result.created[0]);
    expect(page).not.toBeNull();
    expect(page!.frontmatter.ttl).toBe(7 * 24 * 60 * 60);
    expect(page!.frontmatter.expiresAt).toBeDefined();

    // expiresAt should be ~7 days from now
    const expiresAt = new Date(page!.frontmatter.expiresAt!).getTime();
    const sevenDaysFromNow = Date.now() + 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(expiresAt - sevenDaysFromNow)).toBeLessThan(5000); // 5s tolerance
  });

  it('architecture category should NOT have default TTL', () => {
    expect(CATEGORY_DEFAULT_TTL['architecture']).toBeUndefined();

    const result = ingestKnowledge(tempDir, {
      title: 'Arch Test',
      content: 'Architecture knowledge.',
      tags: ['arch'],
      category: 'architecture',
    });

    const page = readPage(tempDir, result.created[0]);
    expect(page).not.toBeNull();
    expect(page!.frontmatter.ttl).toBeUndefined();
    expect(page!.frontmatter.expiresAt).toBeUndefined();
  });
});

// ============================================================================
// Compaction Tests
// ============================================================================

describe('Compaction', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wiki-compact-test-'));
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('countAppendSections should count update sections', () => {
    const content = `
# Original

Content here.

---

## Update (2025-01-01T00:00:00.000Z)

First update.

---

## Update (2025-01-02T00:00:00.000Z)

Second update.
`;
    expect(countAppendSections(content)).toBe(2);
  });

  it('countAppendSections should return 0 for no updates', () => {
    expect(countAppendSections('\n# Title\n\nJust content.\n')).toBe(0);
  });

  it('compactPage should return null when below threshold', () => {
    const page = makePage('small.md', {}, '\n# Title\n\nContent.\n');
    expect(compactPage(page)).toBeNull();
  });

  it('compactPage should compact when above threshold', () => {
    // Build content with COMPACTION_THRESHOLD + 1 update sections
    let content = '\n# Original Title\n\nOriginal content.\n';
    for (let i = 0; i < COMPACTION_THRESHOLD + 1; i++) {
      content += `\n---\n\n## Update (2025-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z)\n\nUpdate ${i + 1} content.\n`;
    }

    const page = makePage('big.md', {}, content);
    const result = compactPage(page);

    expect(result).not.toBeNull();
    // Should keep only COMPACTION_KEEP_RECENT sections
    expect(countAppendSections(result!.content)).toBe(COMPACTION_KEEP_RECENT);
    // Should have compaction notice
    expect(result!.content).toContain('**Compacted:**');
    // Should have compactedAt in frontmatter
    expect(result!.frontmatter.compactedAt).toBeDefined();
    // Original content should be preserved
    expect(result!.content).toContain('Original content.');
  });

  it('compactAllPages should compact eligible pages', () => {
    ensureWikiDir(tempDir);

    // Write a page that needs compaction
    let bigContent = '\n# Big Page\n\nOriginal.\n';
    for (let i = 0; i < COMPACTION_THRESHOLD + 2; i++) {
      bigContent += `\n---\n\n## Update (2025-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z)\n\nUpdate ${i}.\n`;
    }
    writePage(tempDir, makePage('big-page.md', { title: 'Big Page' }, bigContent));

    // Write a small page that doesn't need compaction
    writePage(tempDir, makePage('small-page.md', { title: 'Small Page' }));

    const result = compactAllPages(tempDir);
    expect(result.compacted).toBe(1);
    expect(result.filenames).toContain('big-page.md');

    // Verify the compacted page
    const page = readPage(tempDir, 'big-page.md');
    expect(page).not.toBeNull();
    expect(countAppendSections(page!.content)).toBe(COMPACTION_KEEP_RECENT);
  });
});

// ============================================================================
// CJK Tokenization Tests
// ============================================================================

describe('CJK Tokenization', () => {
  it('should tokenize Latin text normally', () => {
    const tokens = tokenize('Hello World');
    expect(tokens).toContain('hello');
    expect(tokens).toContain('world');
  });

  it('should generate bi-grams for Korean text', () => {
    const tokens = tokenize('인증 아키텍처');
    // Should contain individual chars and bi-grams
    expect(tokens).toContain('인');
    expect(tokens).toContain('증');
    expect(tokens).toContain('인증');
    expect(tokens).toContain('아키');
    expect(tokens).toContain('키텍');
    expect(tokens).toContain('텍처');
  });

  it('should generate bi-grams for Chinese text', () => {
    const tokens = tokenize('数据库');
    expect(tokens).toContain('数据');
    expect(tokens).toContain('据库');
    expect(tokens).toContain('数');
    expect(tokens).toContain('据');
    expect(tokens).toContain('库');
  });

  it('should generate bi-grams for Japanese text', () => {
    const tokens = tokenize('テスト');
    expect(tokens).toContain('テス');
    expect(tokens).toContain('スト');
  });

  it('should handle mixed Latin and CJK text', () => {
    const tokens = tokenize('Auth 인증 module');
    expect(tokens).toContain('auth');
    expect(tokens).toContain('module');
    expect(tokens).toContain('인증');
  });

  it('should find CJK content in wiki query', () => {
    // This is an integration test — we test through queryWiki
    // but it requires setting up a wiki. We test the tokenizer independently.
    const tokens = tokenize('데이터베이스 설계');
    expect(tokens.length).toBeGreaterThan(2);
    expect(tokens).toContain('데이');
    expect(tokens).toContain('이터');
  });
});

// ============================================================================
// 2-Tier Storage Tests
// ============================================================================

describe('2-Tier Storage (Global + Local)', () => {
  let tempDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wiki-tier-test-'));
    // Mock CLAUDE_CONFIG_DIR to use temp dir for global wiki
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'global-config');
    fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  });

  afterEach(async () => {
    if (originalConfigDir !== undefined) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    } else {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('getGlobalWikiDir should use claude config dir', () => {
    const globalDir = getGlobalWikiDir();
    expect(globalDir).toContain('global-config');
    expect(globalDir).toContain('wiki');
  });

  it('should write and read from global wiki', () => {
    const page = makePage('global-convention.md', {
      title: 'Global Convention',
      category: 'convention',
      scope: 'global',
    });

    writeGlobalPage(page);

    const globalPages = readAllGlobalPages();
    expect(globalPages).toHaveLength(1);
    expect(globalPages[0].frontmatter.title).toBe('Global Convention');
  });

  it('should delete from global wiki', () => {
    const page = makePage('to-delete.md', { scope: 'global' });
    writeGlobalPage(page);
    expect(readAllGlobalPages()).toHaveLength(1);

    const deleted = deleteGlobalPage('to-delete.md');
    expect(deleted).toBe(true);
    expect(readAllGlobalPages()).toHaveLength(0);
  });

  it('deleteGlobalPage should return false for non-existent', () => {
    expect(deleteGlobalPage('nonexistent.md')).toBe(false);
  });

  it('convention category should default to global scope', () => {
    expect(GLOBAL_SCOPE_CATEGORIES.has('convention')).toBe(true);
    expect(GLOBAL_SCOPE_CATEGORIES.has('reference')).toBe(true);
  });

  it('architecture category should default to local scope', () => {
    expect(GLOBAL_SCOPE_CATEGORIES.has('architecture')).toBe(false);
    expect(GLOBAL_SCOPE_CATEGORIES.has('debugging')).toBe(false);
  });

  it('ingest with scope=global should write to global tier', () => {
    const localRoot = path.join(tempDir, 'local-repo');
    fs.mkdirSync(localRoot, { recursive: true });

    ingestKnowledge(localRoot, {
      title: 'Team Convention',
      content: 'Always use conventional commits.',
      tags: ['convention'],
      category: 'convention',
      scope: 'global',
    });

    // Should be in global, not local
    const globalPages = readAllGlobalPages();
    expect(globalPages).toHaveLength(1);
    expect(globalPages[0].frontmatter.title).toBe('Team Convention');

    const localPages = readAllPages(localRoot);
    expect(localPages).toHaveLength(0);
  });

  it('ingest with scope=local should write to local tier', () => {
    const localRoot = path.join(tempDir, 'local-repo');
    fs.mkdirSync(localRoot, { recursive: true });

    ingestKnowledge(localRoot, {
      title: 'Local Architecture',
      content: 'Repo-specific arch details.',
      tags: ['arch'],
      category: 'architecture',
      scope: 'local',
    });

    const localPages = readAllPages(localRoot);
    expect(localPages).toHaveLength(1);

    const globalPages = readAllGlobalPages();
    expect(globalPages).toHaveLength(0);
  });

  it('queryWiki should search both tiers', () => {
    const localRoot = path.join(tempDir, 'local-repo');
    fs.mkdirSync(localRoot, { recursive: true });
    ensureWikiDir(localRoot);

    // Write local page
    writePage(localRoot, makePage('local-auth.md', {
      title: 'Local Auth',
      tags: ['auth'],
      category: 'architecture',
    }, '\n# Local Auth\n\nLocal authentication details.\n'));

    // Write global page
    writeGlobalPage(makePage('global-auth-convention.md', {
      title: 'Auth Convention',
      tags: ['auth', 'convention'],
      category: 'convention',
      scope: 'global',
    }, '\n# Auth Convention\n\nGlobal auth conventions.\n'));

    const results = queryWiki(localRoot, 'auth');
    expect(results.length).toBe(2);

    // Local should score higher due to 1.5x boost
    const localResult = results.find(r => r.page.filename === 'local-auth.md');
    const globalResult = results.find(r => r.page.filename === 'global-auth-convention.md');
    expect(localResult).toBeDefined();
    expect(globalResult).toBeDefined();
    expect(localResult!.score).toBeGreaterThanOrEqual(globalResult!.score);
  });

  it('queryWiki should filter expired pages from results', () => {
    const localRoot = path.join(tempDir, 'local-repo');
    fs.mkdirSync(localRoot, { recursive: true });
    ensureWikiDir(localRoot);

    // Write an expired page
    writePage(localRoot, makePage('expired-page.md', {
      title: 'Expired Knowledge',
      tags: ['test'],
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }, '\n# Expired\n\nThis should not appear.\n'));

    // Write a valid page
    writePage(localRoot, makePage('valid-page.md', {
      title: 'Valid Knowledge',
      tags: ['test'],
    }, '\n# Valid\n\nThis should appear.\n'));

    const results = queryWiki(localRoot, 'test');
    expect(results).toHaveLength(1);
    expect(results[0].page.filename).toBe('valid-page.md');
  });

  it('queryWiki should disable global tier when configured', () => {
    const localRoot = path.join(tempDir, 'local-repo');
    fs.mkdirSync(localRoot, { recursive: true });
    ensureWikiDir(localRoot);

    writePage(localRoot, makePage('local.md', { title: 'Local', tags: ['test'] }));
    writeGlobalPage(makePage('global.md', { title: 'Global', tags: ['test'] }));

    const results = queryWiki(localRoot, 'test', {}, {
      autoCapture: true,
      staleDays: 30,
      maxPageSize: 10240,
      enableGlobalTier: false,
      autoGC: true,
      autoCompaction: true,
    });

    expect(results).toHaveLength(1);
    expect(results[0].page.filename).toBe('local.md');
  });
});

// ============================================================================
// Scope Auto-Detection Tests
// ============================================================================

describe('Scope Auto-Detection', () => {
  let tempDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wiki-scope-test-'));
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'global-config');
    fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  });

  afterEach(async () => {
    if (originalConfigDir !== undefined) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    } else {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('convention category without explicit scope should default to local (ingest layer)', () => {
    // At the ingest layer, scope defaults to 'local' for backward compat.
    // Auto-detection (convention → global) happens at the tools layer only.
    ingestKnowledge(tempDir, {
      title: 'Convention Without Scope',
      content: 'Should stay local at ingest layer.',
      tags: ['convention'],
      category: 'convention',
      // No explicit scope → defaults to 'local'
    });

    expect(readAllPages(tempDir)).toHaveLength(1);
    expect(readAllGlobalPages()).toHaveLength(0);
  });

  it('architecture category without explicit scope should go to local', () => {
    ingestKnowledge(tempDir, {
      title: 'Auto Local Arch',
      content: 'Should auto-route to local.',
      tags: ['arch'],
      category: 'architecture',
      // No explicit scope
    });

    expect(readAllPages(tempDir)).toHaveLength(1);
    expect(readAllGlobalPages()).toHaveLength(0);
  });

  it('explicit scope should override auto-detection', () => {
    // Convention normally goes global, but explicit local overrides
    ingestKnowledge(tempDir, {
      title: 'Local Convention',
      content: 'Forced to local.',
      tags: ['convention'],
      category: 'convention',
      scope: 'local', // Override
    });

    expect(readAllPages(tempDir)).toHaveLength(1);
    expect(readAllGlobalPages()).toHaveLength(0);
  });
});
