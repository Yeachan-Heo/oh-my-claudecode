import { describe, it, expect } from 'vitest';
import {
  assembleDraft,
  detectAreaSlug,
  formatTitle,
  INTERVIEW_SLOTS,
  recomputeHashFromDraftFile,
} from '../../issues/draft-assemble.js';
import { renderDraftToMarkdown } from '../../issues/draft-writer.js';

describe('draft-assemble', () => {
  describe('detectAreaSlug', () => {
    it('detects ui keywords', () => {
      expect(detectAreaSlug('add dark mode toggle to settings page')).toBe('ui');
      expect(detectAreaSlug('redesign the sidebar navigation')).toBe('ui');
    });

    it('detects bases keywords', () => {
      expect(detectAreaSlug('linked record field type for bases')).toBe('bases');
    });

    it('returns "general" for unrecognized input', () => {
      expect(detectAreaSlug('xyzzy plugh')).toBe('general');
    });

    it('prefers existing repo labels when keyword maps to one', () => {
      const slug = detectAreaSlug('add dark mode UI', ['area:ui/settings', 'area:bases']);
      expect(slug).toBe('ui/settings');
    });
  });

  describe('formatTitle', () => {
    it('produces [mode:area] prefix', () => {
      const title = formatTitle('feature', 'ui', 'Add dark mode toggle');
      expect(title).toBe('[feature:ui] Add dark mode toggle');
    });

    it('truncates at 80 chars with ...', () => {
      const longSummary = 'A'.repeat(200);
      const title = formatTitle('feature', 'ui', longSummary);
      expect(title.length).toBeLessThanOrEqual(80);
      expect(title.startsWith('[feature:ui]')).toBe(true);
      expect(title.endsWith('...')).toBe(true);
    });
  });

  describe('assembleDraft', () => {
    it('uses interview slot values when present', () => {
      const slots = INTERVIEW_SLOTS.map((s) => ({ ...s }));
      slots[0].value = 'bug';
      slots[1].value = 'users see a flicker on page load';
      slots[2].value = 'preload the theme cookie before render';
      slots[3].value = 'no flicker on first paint';
      slots[4].value = 'mobile is out of scope';
      const draft = assembleDraft('flicker on page load', slots, {});
      expect(draft.mode).toBe('bug');
      expect(draft.body).toContain('flicker on page load');
      expect(draft.body).toContain('preload the theme cookie before render');
      expect(draft.body).not.toContain('_TBD_');
      expect(draft.contentHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('uses _TBD_ placeholders when all interview slots are skipped', () => {
      const slots = INTERVIEW_SLOTS.map((s) => ({ ...s, value: undefined }));
      const draft = assembleDraft('add dark mode', slots, {});
      // mode default is 'feature'
      expect(draft.mode).toBe('feature');
      // four _TBD_ regions: problem, solution, criteria, scope
      const tbdMatches = draft.body.match(/_TBD_/g) ?? [];
      expect(tbdMatches.length).toBeGreaterThanOrEqual(4);
    });

    it('always includes labels: [omc-ready, area:<slug>]', () => {
      const slots = INTERVIEW_SLOTS.map((s) => ({ ...s }));
      const draft = assembleDraft('add dark mode toggle', slots, {});
      expect(draft.labels).toContain('omc-ready');
      expect(draft.labels.some((l) => l.startsWith('area:'))).toBe(true);
    });

    it('respects --label flag additions', () => {
      const slots = INTERVIEW_SLOTS.map((s) => ({ ...s }));
      const draft = assembleDraft('idea', slots, { labels: ['priority:high', 'good-first-issue'] });
      expect(draft.labels).toContain('priority:high');
      expect(draft.labels).toContain('good-first-issue');
    });

    it('source is "idea"', () => {
      const slots = INTERVIEW_SLOTS.map((s) => ({ ...s }));
      const draft = assembleDraft('idea', slots, {});
      expect(draft.source).toBe('idea');
    });
  });

  describe('hash re-derivability (AC-D3-8 contract)', () => {
    it('strips trailing sentinel and recomputes matching hash', () => {
      const slots = INTERVIEW_SLOTS.map((s) => ({ ...s }));
      slots[1].value = 'edge case';
      const draft = assembleDraft('idea', slots, {});
      const file = renderDraftToMarkdown(draft);
      const recomp = recomputeHashFromDraftFile(file);
      expect(recomp).not.toBeNull();
      expect(recomp!.hashSentinel).toBe(draft.contentHash);
      expect(recomp!.recomputed).toBe(recomp!.hashSentinel);
    });

    it('detects edit-then-stale-hash regression', () => {
      const slots = INTERVIEW_SLOTS.map((s) => ({ ...s }));
      slots[1].value = 'first version of the problem';
      const draftA = assembleDraft('idea', slots, {});
      slots[1].value = 'second version of the problem (edited)';
      const draftB = assembleDraft('idea', slots, {});
      expect(draftB.contentHash).not.toBe(draftA.contentHash);
      const fileB = renderDraftToMarkdown(draftB);
      expect(fileB).toContain(`omc-create-hash:${draftB.contentHash}`);
      expect(fileB).not.toContain(`omc-create-hash:${draftA.contentHash}`);
    });

    it('returns null when no sentinel present', () => {
      const file = '---\ntitle: x\n---\n\n## Problem\n\nbody\n';
      expect(recomputeHashFromDraftFile(file)).toBeNull();
    });
  });

  describe('body section ordering (AC-D3-2)', () => {
    it('emits Problem, Proposed Solution, Acceptance Criteria, Out of Scope, Source, OMC in order', () => {
      const slots = INTERVIEW_SLOTS.map((s) => ({ ...s }));
      const draft = assembleDraft('idea', slots, {});
      const headings = ['## Problem', '## Proposed Solution', '## Acceptance Criteria', '## Out of Scope', '## Source', '## OMC'];
      let lastIdx = -1;
      for (const h of headings) {
        const idx = draft.body.indexOf(h);
        expect(idx).toBeGreaterThan(lastIdx);
        lastIdx = idx;
      }
    });
  });
});
