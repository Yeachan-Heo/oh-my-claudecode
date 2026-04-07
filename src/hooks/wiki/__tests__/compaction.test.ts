/**
 * Tests for wiki page compaction.
 *
 * The append-only merge strategy in ingest.ts adds a new section on every
 * wiki_ingest call. Over time this causes pages to grow without bound.
 * Compaction keeps the N most recent sections and replaces older ones
 * with a summary line.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  writePage,
  readPage,
  ensureWikiDir,
  countAppendSections,
  compactPage,
  compactAllPages,
} from '../storage.js';
import { WIKI_SCHEMA_VERSION, COMPACTION_THRESHOLD, COMPACTION_KEEP_RECENT } from '../types.js';
import type { WikiPage } from '../types.js';

function makePage(filename: string, content: string): WikiPage {
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
    },
    content,
  };
}

function buildContentWithSections(numSections: number): string {
  let content = '\n# Original Title\n\nOriginal content.\n';
  for (let i = 0; i < numSections; i++) {
    content += `\n---\n\n## Update (2025-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z)\n\nUpdate ${i + 1} content.\n`;
  }
  return content;
}

describe('countAppendSections', () => {
  it('should return 0 for content with no updates', () => {
    expect(countAppendSections('\n# Title\n\nJust content.\n')).toBe(0);
  });

  it('should count update sections correctly', () => {
    const content = buildContentWithSections(3);
    expect(countAppendSections(content)).toBe(3);
  });

  it('should not count non-matching patterns', () => {
    const content = '\n# Title\n\n---\n\n## Not an Update\n\nNope.\n';
    expect(countAppendSections(content)).toBe(0);
  });
});

describe('compactPage', () => {
  it('should return null when below threshold', () => {
    const page = makePage('small.md', buildContentWithSections(2));
    expect(compactPage(page)).toBeNull();
  });

  it('should return null at exact threshold', () => {
    const page = makePage('exact.md', buildContentWithSections(COMPACTION_THRESHOLD - 1));
    expect(compactPage(page)).toBeNull();
  });

  it('should compact when above threshold', () => {
    const page = makePage('big.md', buildContentWithSections(COMPACTION_THRESHOLD + 1));
    const result = compactPage(page);

    expect(result).not.toBeNull();
    expect(countAppendSections(result!.content)).toBe(COMPACTION_KEEP_RECENT);
    expect(result!.content).toContain('**Compacted:**');
    expect(result!.content).toContain('Original content.');
  });

  it('should keep only the most recent sections', () => {
    const numSections = COMPACTION_THRESHOLD + 3;
    const page = makePage('many.md', buildContentWithSections(numSections));
    const result = compactPage(page)!;

    // The last COMPACTION_KEEP_RECENT sections should be preserved
    const lastSectionDate = `2025-01-${String(numSections).padStart(2, '0')}`;
    expect(result.content).toContain(lastSectionDate);

    // The first section should be removed
    expect(result.content).not.toContain('Update 1 content.');
  });

  it('should update the frontmatter updated timestamp', () => {
    const page = makePage('ts.md', buildContentWithSections(COMPACTION_THRESHOLD + 1));
    const result = compactPage(page)!;
    expect(result.frontmatter.updated).not.toBe('2025-01-01T00:00:00.000Z');
  });
});

describe('compactAllPages', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wiki-compact-test-'));
    ensureWikiDir(tempDir);
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('should compact eligible pages and skip others', () => {
    writePage(tempDir, makePage('big.md', buildContentWithSections(COMPACTION_THRESHOLD + 2)));
    writePage(tempDir, makePage('small.md', '\n# Small\n\nTiny page.\n'));

    const result = compactAllPages(tempDir);
    expect(result.compacted).toBe(1);
    expect(result.filenames).toContain('big.md');

    const page = readPage(tempDir, 'big.md');
    expect(countAppendSections(page!.content)).toBe(COMPACTION_KEEP_RECENT);
  });

  it('should return 0 when nothing needs compaction', () => {
    writePage(tempDir, makePage('ok.md', '\n# OK\n\nFine.\n'));
    expect(compactAllPages(tempDir).compacted).toBe(0);
  });
});
