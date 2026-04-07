/**
 * Tests for CJK tokenization in wiki query.
 *
 * The default whitespace-split tokenizer produces zero tokens for CJK text
 * (Korean, Chinese, Japanese) because these languages don't use spaces
 * between words. This causes wiki_query to return 0 results for CJK queries.
 *
 * Fix: bi-gram tokenizer that generates 2-character sliding windows for CJK
 * segments, plus individual characters for single-char query support.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { tokenize } from '../query.js';
import { queryWiki } from '../query.js';
import { writePage, ensureWikiDir } from '../storage.js';
import { WIKI_SCHEMA_VERSION } from '../types.js';
import type { WikiPage } from '../types.js';

function makePage(filename: string, opts: {
  title?: string;
  tags?: string[];
  content?: string;
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
      category: 'reference' as const,
      confidence: 'medium' as const,
      schemaVersion: WIKI_SCHEMA_VERSION,
    },
    content: opts.content || `\n# ${opts.title || filename}\n\nDefault content.\n`,
  };
}

describe('tokenize', () => {
  it('should tokenize Latin text by whitespace', () => {
    const tokens = tokenize('Hello World');
    expect(tokens).toContain('hello');
    expect(tokens).toContain('world');
  });

  it('should produce bi-grams for Korean', () => {
    const tokens = tokenize('인증');
    expect(tokens).toContain('인');
    expect(tokens).toContain('증');
    expect(tokens).toContain('인증');
  });

  it('should produce bi-grams for Chinese', () => {
    const tokens = tokenize('数据库');
    expect(tokens).toContain('数据');
    expect(tokens).toContain('据库');
  });

  it('should produce bi-grams for Japanese katakana', () => {
    const tokens = tokenize('テスト');
    expect(tokens).toContain('テス');
    expect(tokens).toContain('スト');
  });

  it('should handle mixed Latin and CJK', () => {
    const tokens = tokenize('Auth 인증');
    expect(tokens).toContain('auth');
    expect(tokens).toContain('인증');
  });

  it('should return empty for empty string', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('should tokenize Cyrillic text by whitespace', () => {
    const tokens = tokenize('привет мир');
    expect(tokens).toContain('привет');
    expect(tokens).toContain('мир');
  });

  it('should tokenize Arabic text by whitespace', () => {
    const tokens = tokenize('مرحبا بالعالم');
    expect(tokens).toContain('مرحبا');
    expect(tokens).toContain('بالعالم');
  });

  it('should not produce bi-grams from CJK punctuation', () => {
    const tokens = tokenize('「テスト」');
    // Should contain Katakana bi-grams but not punctuation bi-grams
    expect(tokens).toContain('テス');
    expect(tokens).toContain('スト');
    expect(tokens).not.toContain('「テ');
    expect(tokens).not.toContain('ト」');
  });

  it('should preserve accented Latin words as single tokens', () => {
    const tokens = tokenize('café naïve résumé');
    expect(tokens).toContain('café');
    expect(tokens).toContain('naïve');
    expect(tokens).toContain('résumé');
  });

  it('should not emit punctuation-only tokens', () => {
    const tokens = tokenize('jwt-based foo.bar C++');
    expect(tokens).toContain('jwt');
    expect(tokens).toContain('based');
    expect(tokens).toContain('foo');
    expect(tokens).toContain('bar');
    expect(tokens).not.toContain('-');
    expect(tokens).not.toContain('.');
    expect(tokens).not.toContain('++');
  });
});

describe('queryWiki with CJK content', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wiki-cjk-test-'));
    ensureWikiDir(tempDir);
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('should find pages with Korean content', () => {
    writePage(tempDir, makePage('auth.md', {
      title: '인증 아키텍처',
      tags: ['인증'],
      content: '\n# 인증 아키텍처\n\nJWT 기반 인증 흐름 설명.\n',
    }));

    const results = queryWiki(tempDir, '인증');
    expect(results.length).toBe(1);
    expect(results[0].page.filename).toBe('auth.md');
  });

  it('should find pages with Chinese content', () => {
    writePage(tempDir, makePage('db.md', {
      title: '数据库架构',
      content: '\n# 数据库\n\n数据库设计文档.\n',
    }));

    const results = queryWiki(tempDir, '数据库');
    expect(results.length).toBe(1);
  });

  it('should find pages with mixed language query', () => {
    writePage(tempDir, makePage('mixed.md', {
      title: 'Auth 인증 Module',
      content: '\n# Auth 인증\n\nAuthentication module with 인증 support.\n',
    }));

    const results = queryWiki(tempDir, 'Auth 인증');
    expect(results.length).toBe(1);
    expect(results[0].score).toBeGreaterThan(0);
  });
});
