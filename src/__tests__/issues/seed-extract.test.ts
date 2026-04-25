import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseMarkdownHeadings,
  shouldSkipHeading,
  slugifyTitle,
  extractIssuesFromDocs,
  writeDraftsAndManifest,
  DEFAULT_EXCLUDED_FILES,
} from '../../issues/seed-extract.js';
import { computeContentHash, readManifest } from '../../issues/draft-writer.js';

const SAMPLE_PRD = `# Project PRD

## Overview

Background text that should not generate an issue.

## Linked record field type with cross-table lookups

The system shall support linked record fields that reference rows in other tables.
Users must be able to look up a value across linked tables.

- [ ] Field type registered
- The lookup must support both 1:N and N:N relations.

## Formula field with expression engine

Formula fields can compute values from other fields.

## Table of contents

(structural — should be skipped)
`;

const SAMPLE_MOCKUP_README = `# Bases Navigation Revamp

This mock-up explores a redesigned sidebar for bases navigation.

## Goals

- Allow rapid base switching.
- Surface recent records in the sidebar.

## Screens

See the attached PNGs for the proposed layout.
`;

const SAMPLE_README_TODO = `# Project README

Some intro text.

## TODO

- Document the API surface.
- Add a quickstart guide.

## Roadmap

Future work includes a mobile companion.
`;

const SAMPLE_README_NO_TODO = `# Project README

Just an introduction. No actionable backlog here.

## Background

History of the project.
`;

describe('seed-extract', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omc-seed-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeFixture(rel: string, content: string): void {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }

  describe('parseMarkdownHeadings', () => {
    it('extracts H2 and H3 sections with line ranges', () => {
      const sections = parseMarkdownHeadings(SAMPLE_PRD);
      const titles = sections.map((s) => s.heading);
      expect(titles).toContain('Overview');
      expect(titles).toContain('Linked record field type with cross-table lookups');
      expect(titles).toContain('Formula field with expression engine');
      expect(titles).toContain('Table of contents');
      const linkedRow = sections.find((s) => s.heading.startsWith('Linked record'));
      expect(linkedRow?.startLine).toBeGreaterThan(0);
      expect(linkedRow?.endLine).toBeGreaterThan(linkedRow!.startLine);
    });
  });

  describe('shouldSkipHeading', () => {
    it('skips structural headings', () => {
      expect(shouldSkipHeading('Overview')).toBe(true);
      expect(shouldSkipHeading('Background')).toBe(true);
      expect(shouldSkipHeading('Table of contents')).toBe(true);
    });

    it('does not skip feature headings', () => {
      expect(shouldSkipHeading('Linked record field type')).toBe(false);
      expect(shouldSkipHeading('Formula field')).toBe(false);
    });
  });

  describe('slugifyTitle', () => {
    it('returns full string when under maxLen', () => {
      expect(slugifyTitle('[area:bases]', 'Linked record field type', 80)).toBe(
        '[area:bases] Linked record field type',
      );
    });

    it('truncates with ... when over maxLen', () => {
      const longHeading = 'A'.repeat(120);
      const result = slugifyTitle('[area:bases]', longHeading, 80);
      expect(result.length).toBeLessThanOrEqual(80);
      expect(result.endsWith('...')).toBe(true);
    });
  });

  describe('extractIssuesFromDocs', () => {
    it('produces 2 drafts from PRD (structural headings excluded)', () => {
      writeFixture('docs/BASES-PRD.md', SAMPLE_PRD);
      const drafts = extractIssuesFromDocs(['docs/BASES-PRD.md'], {
        rootDir: root,
        outputDir: join(root, '.omc/seed-issues'),
        manifestPath: join(root, '.omc/seed-issues/manifest.json'),
      });
      const titles = drafts.map((d) => d.title);
      expect(titles.some((t) => t.includes('Linked record field type'))).toBe(true);
      expect(titles.some((t) => t.includes('Formula field with expression engine'))).toBe(true);
      expect(titles.some((t) => t.includes('Overview'))).toBe(false);
      expect(titles.some((t) => t.includes('Table of contents'))).toBe(false);
    });

    it('extracts acceptance criteria from keyword-matched bullets', () => {
      writeFixture('docs/BASES-PRD.md', SAMPLE_PRD);
      const drafts = extractIssuesFromDocs(['docs/BASES-PRD.md'], {
        rootDir: root,
        outputDir: join(root, '.omc/seed-issues'),
        manifestPath: join(root, '.omc/seed-issues/manifest.json'),
      });
      const linked = drafts.find((d) => d.title.includes('Linked record'));
      expect(linked?.body).toMatch(/## Acceptance Criteria/);
      expect(linked?.body).toMatch(/lookup must support/);
    });

    it('produces a single draft for a mock-up README with area:ui label', () => {
      writeFixture('docs/mock-ups/bases-navigation-revamp/README.md', SAMPLE_MOCKUP_README);
      const drafts = extractIssuesFromDocs(['docs/mock-ups/bases-navigation-revamp/README.md'], {
        rootDir: root,
        outputDir: join(root, '.omc/seed-issues'),
        manifestPath: join(root, '.omc/seed-issues/manifest.json'),
      });
      expect(drafts.length).toBeGreaterThan(0);
      for (const d of drafts) {
        expect(d.labels).toContain('area:ui');
        expect(d.title).toContain('[area:ui/bases-navigation-revamp]');
      }
    });

    it('only seeds README sections under TODO/Roadmap headings', () => {
      writeFixture('README.md', SAMPLE_README_TODO);
      const drafts = extractIssuesFromDocs(['README.md'], {
        rootDir: root,
        outputDir: join(root, '.omc/seed-issues'),
        manifestPath: join(root, '.omc/seed-issues/manifest.json'),
      });
      const titles = drafts.map((d) => d.title);
      expect(titles.some((t) => t.toLowerCase().includes('todo'))).toBe(true);
      expect(titles.some((t) => t.toLowerCase().includes('roadmap'))).toBe(true);
    });

    it('skips README with no TODO/Roadmap section', () => {
      writeFixture('README.md', SAMPLE_README_NO_TODO);
      const drafts = extractIssuesFromDocs(['README.md'], {
        rootDir: root,
        outputDir: join(root, '.omc/seed-issues'),
        manifestPath: join(root, '.omc/seed-issues/manifest.json'),
      });
      expect(drafts).toHaveLength(0);
    });

    it('PRODUCT-PRINCIPLES.md is in the default excluded list', () => {
      expect(DEFAULT_EXCLUDED_FILES).toContain('docs/PRODUCT-PRINCIPLES.md');
    });
  });

  describe('writeDraftsAndManifest', () => {
    it('writes one draft file per draft and one manifest entry per draft', () => {
      writeFixture('docs/BASES-PRD.md', SAMPLE_PRD);
      const opts = {
        rootDir: root,
        outputDir: join(root, '.omc/seed-issues'),
        manifestPath: join(root, '.omc/seed-issues/manifest.json'),
      };
      const drafts = extractIssuesFromDocs(['docs/BASES-PRD.md'], opts);
      const result = writeDraftsAndManifest(drafts, opts);
      const files = readdirSync(opts.outputDir).filter((f) => f.endsWith('.md'));
      expect(files.length).toBe(drafts.length);
      const manifest = readManifest(opts.manifestPath);
      expect(manifest).toHaveLength(drafts.length);
      for (const e of manifest) {
        expect(e.source).toBe('docs');
        expect(e.status).toBe('draft');
        expect(e.content_hash).toMatch(/^[a-f0-9]{64}$/);
      }
    });

    it('hash sentinel in draft file matches manifest entry', () => {
      writeFixture('docs/BASES-PRD.md', SAMPLE_PRD);
      const opts = {
        rootDir: root,
        outputDir: join(root, '.omc/seed-issues'),
        manifestPath: join(root, '.omc/seed-issues/manifest.json'),
      };
      const drafts = extractIssuesFromDocs(['docs/BASES-PRD.md'], opts);
      const result = writeDraftsAndManifest(drafts, opts);
      const files = readdirSync(opts.outputDir).filter((f) => f.endsWith('.md')).sort();
      for (let i = 0; i < files.length; i++) {
        const content = readFileSync(join(opts.outputDir, files[i]), 'utf-8');
        const m = /<!-- omc-seed-hash:([a-f0-9]{64}) -->/.exec(content);
        expect(m).not.toBeNull();
        expect(m![1]).toBe(result.manifestEntries[i].content_hash);
      }
    });
  });

  describe('content hash determinism (D2 re-derivability)', () => {
    it('same source section produces same hash', () => {
      const a = computeContentHash('heading\nbody text');
      const b = computeContentHash('heading\nbody text');
      expect(a).toBe(b);
    });
  });
});
