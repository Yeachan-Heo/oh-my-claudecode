/**
 * Tests for Wiki Ingest
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { ingestKnowledge } from '../ingest.js';
import { readPage, readLog } from '../storage.js';

describe('Wiki Ingest', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wiki-ingest-test-'));
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  describe('create new page', () => {
    it('should create a new page when slug does not exist', () => {
      const result = ingestKnowledge(tempDir, {
        title: 'Auth Architecture',
        content: 'JWT-based authentication flow.',
        tags: ['auth', 'architecture'],
        category: 'architecture',
      });

      expect(result.created).toEqual(['auth-architecture.md']);
      expect(result.updated).toEqual([]);
      expect(result.totalAffected).toBe(1);

      const page = readPage(tempDir, 'auth-architecture.md');
      expect(page).not.toBeNull();
      expect(page!.frontmatter.title).toBe('Auth Architecture');
      expect(page!.frontmatter.tags).toEqual(['auth', 'architecture']);
      expect(page!.frontmatter.category).toBe('architecture');
      expect(page!.frontmatter.confidence).toBe('medium');
      expect(page!.content).toContain('JWT-based authentication flow');
    });

    it('should use provided confidence', () => {
      ingestKnowledge(tempDir, {
        title: 'High Confidence',
        content: 'Very sure about this.',
        tags: ['test'],
        category: 'decision',
        confidence: 'high',
      });

      const page = readPage(tempDir, 'high-confidence.md');
      expect(page!.frontmatter.confidence).toBe('high');
    });

    it('should extract wiki links', () => {
      ingestKnowledge(tempDir, {
        title: 'Linking Page',
        content: 'See [[Auth Architecture]] and [[Database Schema]].',
        tags: ['test'],
        category: 'reference',
      });

      const page = readPage(tempDir, 'linking-page.md');
      expect(page!.frontmatter.links).toContain('auth-architecture.md');
      expect(page!.frontmatter.links).toContain('database-schema.md');
    });

    it('should log the ingest operation', () => {
      ingestKnowledge(tempDir, {
        title: 'Logged Page',
        content: 'Content.',
        tags: ['test'],
        category: 'reference',
      });

      const log = readLog(tempDir);
      expect(log).not.toBeNull();
      expect(log).toContain('ingest');
      expect(log).toContain('Created new page');
    });
  });

  describe('merge into existing page', () => {
    it('should append content to existing page', () => {
      // First ingest
      ingestKnowledge(tempDir, {
        title: 'Merge Target',
        content: 'Original content.',
        tags: ['tag1'],
        category: 'architecture',
      });

      // Second ingest with same slug
      const result = ingestKnowledge(tempDir, {
        title: 'Merge Target',
        content: 'Updated content.',
        tags: ['tag2'],
        category: 'architecture',
      });

      expect(result.created).toEqual([]);
      expect(result.updated).toEqual(['merge-target.md']);

      const page = readPage(tempDir, 'merge-target.md');
      expect(page!.content).toContain('Original content');
      expect(page!.content).toContain('Updated content');
      expect(page!.content).toContain('## Update');
    });

    it('should union tags on merge', () => {
      ingestKnowledge(tempDir, {
        title: 'Tag Test',
        content: 'First.',
        tags: ['a', 'b'],
        category: 'reference',
      });

      ingestKnowledge(tempDir, {
        title: 'Tag Test',
        content: 'Second.',
        tags: ['b', 'c'],
        category: 'reference',
      });

      const page = readPage(tempDir, 'tag-test.md');
      expect(page!.frontmatter.tags).toEqual(expect.arrayContaining(['a', 'b', 'c']));
      expect(page!.frontmatter.tags.length).toBe(3);
    });

    it('should keep higher confidence on merge', () => {
      ingestKnowledge(tempDir, {
        title: 'Confidence',
        content: 'First.',
        tags: ['test'],
        category: 'reference',
        confidence: 'high',
      });

      ingestKnowledge(tempDir, {
        title: 'Confidence',
        content: 'Second.',
        tags: ['test'],
        category: 'reference',
        confidence: 'low',
      });

      const page = readPage(tempDir, 'confidence.md');
      expect(page!.frontmatter.confidence).toBe('high');
    });

    it('should upgrade confidence when new is higher', () => {
      ingestKnowledge(tempDir, {
        title: 'Upgrade',
        content: 'First.',
        tags: ['test'],
        category: 'reference',
        confidence: 'low',
      });

      ingestKnowledge(tempDir, {
        title: 'Upgrade',
        content: 'Second.',
        tags: ['test'],
        category: 'reference',
        confidence: 'high',
      });

      const page = readPage(tempDir, 'upgrade.md');
      expect(page!.frontmatter.confidence).toBe('high');
    });

    it('should append sources on merge', () => {
      ingestKnowledge(tempDir, {
        title: 'Sources',
        content: 'First.',
        tags: ['test'],
        category: 'reference',
        sources: ['session-1'],
      });

      ingestKnowledge(tempDir, {
        title: 'Sources',
        content: 'Second.',
        tags: ['test'],
        category: 'reference',
        sources: ['session-2'],
      });

      const page = readPage(tempDir, 'sources.md');
      expect(page!.frontmatter.sources).toEqual(expect.arrayContaining(['session-1', 'session-2']));
    });
  });

  describe('deduplication', () => {
    it('should deduplicate tags', () => {
      ingestKnowledge(tempDir, {
        title: 'Dedup',
        content: 'Content.',
        tags: ['a', 'a', 'b'],
        category: 'reference',
      });

      const page = readPage(tempDir, 'dedup.md');
      expect(page!.frontmatter.tags).toEqual(['a', 'b']);
    });
  });
});
