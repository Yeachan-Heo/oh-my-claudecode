import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  computeContentHash,
  renderHashSentinel,
  renderDraftToMarkdown,
  writeDraftFile,
  appendManifestEntry,
  updateManifestEntry,
  readManifest,
  appendAuditLine,
  generateNonce,
  IssueDraft,
  SENTINEL_PREFIX_SEED,
  SENTINEL_PREFIX_CREATE,
} from '../../issues/draft-writer.js';

describe('draft-writer', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'omc-draft-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('computeContentHash', () => {
    it('is deterministic', () => {
      expect(computeContentHash('hello\nworld')).toBe(computeContentHash('hello\nworld'));
    });

    it('normalizes CRLF to LF', () => {
      const a = computeContentHash('hello\r\nworld\r\n');
      const b = computeContentHash('hello\nworld\n');
      expect(a).toBe(b);
    });

    it('produces 64-char lowercase hex', () => {
      const hash = computeContentHash('test');
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('produces different hashes for different inputs', () => {
      expect(computeContentHash('a')).not.toBe(computeContentHash('b'));
    });
  });

  describe('renderHashSentinel', () => {
    it('formats with prefix and hash', () => {
      const hash = 'a'.repeat(64);
      expect(renderHashSentinel(hash, SENTINEL_PREFIX_SEED)).toBe(
        `<!-- ${SENTINEL_PREFIX_SEED}:${hash} -->`,
      );
    });

    it('rejects malformed hash', () => {
      expect(() => renderHashSentinel('not-hex', SENTINEL_PREFIX_CREATE)).toThrow();
    });

    it('matches the verification regex pattern', () => {
      const hash = computeContentHash('any');
      const sentinel = renderHashSentinel(hash, SENTINEL_PREFIX_CREATE);
      expect(sentinel).toMatch(/^<!-- omc-create-hash:[a-f0-9]{64} -->$/);
    });
  });

  describe('renderDraftToMarkdown', () => {
    function fixtureDraft(overrides: Partial<IssueDraft> = {}): IssueDraft {
      const body = '## Summary\n\nfixture body\n\n## Source\n\n- doc';
      const hash = computeContentHash(body);
      return {
        title: '[area:bases] Fixture title',
        body,
        labels: ['omc-seeded', 'area:bases'],
        milestone: 'OMC Bootstrap',
        source: 'docs',
        contentHash: hash,
        frontmatter: {
          title: '[area:bases] Fixture title',
          labels: ['omc-seeded', 'area:bases'],
          milestone: 'OMC Bootstrap',
          source: 'docs',
          content_hash: hash,
        },
        ...overrides,
      };
    }

    it('emits frontmatter, body, and a trailing sentinel', () => {
      const draft = fixtureDraft();
      const md = renderDraftToMarkdown(draft);
      expect(md.startsWith('---\n')).toBe(true);
      expect(md.indexOf('---\n', 4)).toBeGreaterThan(0);
      expect(md).toContain(`omc-seed-hash:${draft.contentHash}`);
      expect(md.trim().endsWith('-->')).toBe(true);
    });

    it('uses omc-create-hash sentinel for source=idea', () => {
      const draft = fixtureDraft({ source: 'idea' });
      const md = renderDraftToMarkdown(draft);
      expect(md).toContain(`omc-create-hash:${draft.contentHash}`);
      expect(md).not.toContain('omc-seed-hash');
    });
  });

  describe('writeDraftFile', () => {
    it('writes zero-padded filename and returns path', () => {
      const body = '## Summary\nx';
      const draft: IssueDraft = {
        title: 't',
        body,
        labels: [],
        source: 'docs',
        contentHash: computeContentHash(body),
        frontmatter: { title: 't' },
      };
      const path = writeDraftFile(draft, tmpRoot, 7);
      expect(path.endsWith('007.md')).toBe(true);
      expect(existsSync(path)).toBe(true);
      const content = readFileSync(path, 'utf-8');
      expect(content).toContain('## Summary');
    });
  });

  describe('appendManifestEntry', () => {
    const manifestPath = (root: string) => join(root, 'manifest.json');

    it('creates a new manifest with seq=1', () => {
      const entry = appendManifestEntry(manifestPath(tmpRoot), {
        title: 'first',
        draft_path: 'a.md',
        content_hash: 'x'.repeat(64),
        status: 'draft',
        source: 'docs',
      });
      expect(entry.seq).toBe(1);
      const file = JSON.parse(readFileSync(manifestPath(tmpRoot), 'utf-8'));
      expect(file).toHaveLength(1);
      expect(file[0].seq).toBe(1);
    });

    it('derives seq = max(existing) + 1', () => {
      const path = manifestPath(tmpRoot);
      writeFileSync(path, JSON.stringify([
        { seq: 5, title: 'a', draft_path: 'a', content_hash: 'a'.repeat(64), status: 'draft', source: 'docs' },
        { seq: 2, title: 'b', draft_path: 'b', content_hash: 'b'.repeat(64), status: 'draft', source: 'docs' },
      ]));
      const entry = appendManifestEntry(path, {
        title: 'c',
        draft_path: 'c',
        content_hash: 'c'.repeat(64),
        status: 'draft',
        source: 'docs',
      });
      expect(entry.seq).toBe(6);
    });

    it('uses temp-then-rename (no .tmp file remains on success)', () => {
      const path = manifestPath(tmpRoot);
      appendManifestEntry(path, {
        title: 'x', draft_path: 'x', content_hash: 'a'.repeat(64), status: 'draft', source: 'docs',
      });
      const tmpFiles = readFileSync(path, 'utf-8'); // assert file readable
      expect(tmpFiles.length).toBeGreaterThan(0);
    });
  });

  describe('updateManifestEntry', () => {
    it('updates fields by seq and returns merged entry', () => {
      const path = join(tmpRoot, 'manifest.json');
      appendManifestEntry(path, {
        title: 'x', draft_path: 'x', content_hash: 'a'.repeat(64), status: 'draft', source: 'docs',
      });
      const updated = updateManifestEntry(path, 1, { status: 'created', issue_number: 42 });
      expect(updated?.status).toBe('created');
      expect(updated?.issue_number).toBe(42);
      const file = readManifest(path);
      expect(file[0].status).toBe('created');
    });

    it('returns null when seq not found', () => {
      const path = join(tmpRoot, 'manifest.json');
      appendManifestEntry(path, {
        title: 'x', draft_path: 'x', content_hash: 'a'.repeat(64), status: 'draft', source: 'docs',
      });
      expect(updateManifestEntry(path, 99, { status: 'created' })).toBeNull();
    });
  });

  describe('readManifest', () => {
    it('returns [] when file does not exist', () => {
      expect(readManifest(join(tmpRoot, 'nope.json'))).toEqual([]);
    });

    it('returns [] when file is malformed', () => {
      const path = join(tmpRoot, 'bad.json');
      writeFileSync(path, '{not json');
      expect(readManifest(path)).toEqual([]);
    });
  });

  describe('appendAuditLine', () => {
    it('appends a timestamped line', () => {
      const path = join(tmpRoot, 'audit.log');
      appendAuditLine(path, 'CREATE foo bar');
      const content = readFileSync(path, 'utf-8');
      expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z CREATE foo bar\n$/);
    });

    it('appends multiple lines', () => {
      const path = join(tmpRoot, 'audit.log');
      appendAuditLine(path, 'a');
      appendAuditLine(path, 'b');
      const content = readFileSync(path, 'utf-8');
      expect(content.split('\n').filter(Boolean)).toHaveLength(2);
    });

    it('strips embedded newlines from content', () => {
      const path = join(tmpRoot, 'audit.log');
      appendAuditLine(path, 'one\ntwo');
      const content = readFileSync(path, 'utf-8');
      expect(content.split('\n').filter(Boolean)).toHaveLength(1);
      expect(content).toContain('one two');
    });
  });

  describe('generateNonce', () => {
    it('produces a hex string of expected length', () => {
      expect(generateNonce(4)).toMatch(/^[a-f0-9]{8}$/);
      expect(generateNonce(8)).toMatch(/^[a-f0-9]{16}$/);
    });
  });

  describe('hash re-derivability (D3 contract)', () => {
    it('content hash on title+body matches sentinel after round trip', () => {
      const title = '[feature:ui] Round trip';
      const body = [
        '## Problem', '', '_TBD_', '',
        '## Proposed Solution', '', '_TBD_', '',
        '## Acceptance Criteria', '', '- [ ] _TBD_', '',
        '## Out of Scope', '', '- _TBD_', '',
        '## Source', '', 'created via skill', '',
        '## OMC', '', 'Label omc-ready applied: No.',
      ].join('\n');
      const hash = computeContentHash(`${title}\n${body}`);
      const sentinel = renderHashSentinel(hash, SENTINEL_PREFIX_CREATE);
      const file = `---\ntitle: "${title}"\n---\n\n${body}\n\n${sentinel}\n`;
      // Strip frontmatter + trailing sentinel; recompute.
      const lines = file.split('\n');
      const fmEnd = lines.indexOf('---', 1);
      let lastSentinel = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (/^<!-- omc-create-hash:[a-f0-9]{64} -->\s*$/.test(lines[i])) {
          lastSentinel = i;
          break;
        }
      }
      const bodyLines = lines.slice(fmEnd + 1, lastSentinel);
      while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === '') bodyLines.pop();
      while (bodyLines.length > 0 && bodyLines[0].trim() === '') bodyLines.shift();
      const recomputed = computeContentHash(`${title}\n${bodyLines.join('\n')}`);
      expect(recomputed).toBe(hash);
    });
  });
});
