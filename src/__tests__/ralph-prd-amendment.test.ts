import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readPrd,
  writePrd,
  findPrdPath,
  getPrdStatus,
  getSessionPrdPath,
  markStoryComplete,
  amendCriterion,
  supersedeCriterion,
  formatStory,
  formatPrd,
  formatNextStoryPrompt,
  formatCriterionAmendments,
  createPrd,
  MIN_CRITERION_EVIDENCE_LENGTH,
  type PRD,
  type UserStory,
  type CriterionAmendment,
} from '../hooks/ralph/index.js';
import {
  getArchitectVerificationPrompt,
  type VerificationState,
} from '../hooks/ralph/verifier.js';

const FDFT_ORIGINAL =
  'All 16 files that set FDFT_WHALE_STREAM=1 are classified affected/not-affected WITH EVIDENCE';
const FDFT_REPLACEMENT =
  'All 12 files that set FDFT_WHALE_STREAM=1 are classified affected/not-affected WITH EVIDENCE';

const amendmentBase = {
  reason: 'The brief count was wrong: 7 listed names are readers/asserters/doc-recipes, not setters',
  evidence: 'Enumerated setters via grep FDFT_WHALE_STREAM=1: 12 setters, 16 total matches',
  authority: 'ses_test-amendment',
  timestamp: '2026-08-10T03:15:00.000Z',
};

function resultAmendment(): CriterionAmendment {
  return {
    kind: 'replaced',
    original: FDFT_ORIGINAL,
    replacement: FDFT_REPLACEMENT,
    reason: amendmentBase.reason,
    evidence: amendmentBase.evidence,
    authority: amendmentBase.authority,
    timestamp: amendmentBase.timestamp,
  };
}

describe('Ralph PRD Criterion Amendment', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `ralph-prd-amendment-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  const samplePrd: PRD = {
    project: 'TestProject',
    branchName: 'ralph/test-feature',
    description: 'Classify FDFT_WHALE_STREAM usage',
    userStories: [
      {
        id: 'US-001',
        title: 'Classify setters',
        description: 'Classify every file that sets FDFT_WHALE_STREAM=1',
        acceptanceCriteria: [FDFT_ORIGINAL],
        priority: 1,
        passes: false,
        architectVerified: false,
      },
    ],
  };

  function writeSamplePrd(prd: PRD = samplePrd): void {
    expect(writePrd(testDir, prd)).toBe(true);
  }

  describe('amendCriterion', () => {
    it('replaces an active criterion and retains the original verbatim in the ledger', () => {
      writeSamplePrd();

      const result = amendCriterion(testDir, 'US-001', {
        original: FDFT_ORIGINAL,
        replacement: FDFT_REPLACEMENT,
        ...amendmentBase,
      });

      expect(result.ok).toBe(true);
      expect(result.amendment).toEqual(resultAmendment());

      const prd = readPrd(testDir);
      const story = prd?.userStories[0];
      expect(story?.acceptanceCriteria).toEqual([FDFT_REPLACEMENT]);
      expect(story?.criterionAmendments).toHaveLength(1);
      expect(story?.criterionAmendments?.[0].original).toBe(FDFT_ORIGINAL);
    });

    it('inserts the replacement at the original criterion position', () => {
      const prd: PRD = {
        ...samplePrd,
        userStories: [
          {
            ...samplePrd.userStories[0],
            acceptanceCriteria: ['first', FDFT_ORIGINAL, 'last'],
          },
        ],
      };
      writeSamplePrd(prd);

      const result = amendCriterion(testDir, 'US-001', {
        original: FDFT_ORIGINAL,
        replacement: FDFT_REPLACEMENT,
        ...amendmentBase,
      });

      expect(result.ok).toBe(true);
      expect(readPrd(testDir)?.userStories[0].acceptanceCriteria).toEqual([
        'first',
        FDFT_REPLACEMENT,
        'last',
      ]);
    });

    it('defaults the timestamp to now when omitted', () => {
      writeSamplePrd();
      const before = Date.now();

      const result = amendCriterion(testDir, 'US-001', {
        original: FDFT_ORIGINAL,
        replacement: FDFT_REPLACEMENT,
        reason: amendmentBase.reason,
        evidence: amendmentBase.evidence,
        authority: amendmentBase.authority,
      });

      expect(result.ok).toBe(true);
      const recorded = readPrd(testDir)?.userStories[0].criterionAmendments?.[0];
      expect(recorded?.timestamp).toBeDefined();
      const parsed = Date.parse(recorded?.timestamp ?? '');
      expect(Number.isNaN(parsed)).toBe(false);
      expect(parsed).toBeGreaterThanOrEqual(before);
    });

    it('round-trips the ledger through a write/read cycle', () => {
      writeSamplePrd();
      amendCriterion(testDir, 'US-001', {
        original: FDFT_ORIGINAL,
        replacement: FDFT_REPLACEMENT,
        ...amendmentBase,
      });

      const story = readPrd(testDir)?.userStories[0];
      expect(story?.criterionAmendments).toEqual([resultAmendment()]);
    });

    it('is session-scoped', () => {
      writeSamplePrd();
      amendCriterion(testDir, 'US-001', {
        original: FDFT_ORIGINAL,
        replacement: FDFT_REPLACEMENT,
        ...amendmentBase,
      }, 'session-a');

      expect(readPrd(testDir, 'session-a')?.userStories[0].acceptanceCriteria).toEqual([FDFT_REPLACEMENT]);
      expect(readPrd(testDir, 'session-b')?.userStories[0].acceptanceCriteria).toEqual([FDFT_ORIGINAL]);
      expect(findPrdPath(testDir, 'session-a')).toBe(getSessionPrdPath(testDir, 'session-a'));
    });
  });

  describe('supersedeCriterion', () => {
    it('removes the criterion with no replacement and retains the original', () => {
      writeSamplePrd();

      const result = supersedeCriterion(testDir, 'US-001', { original: FDFT_ORIGINAL, ...amendmentBase });

      expect(result.ok).toBe(true);
      expect(result.amendment).toEqual({
        kind: 'superseded',
        original: FDFT_ORIGINAL,
        reason: amendmentBase.reason,
        evidence: amendmentBase.evidence,
        authority: amendmentBase.authority,
        timestamp: amendmentBase.timestamp,
      });

      const story = readPrd(testDir)?.userStories[0];
      expect(story?.acceptanceCriteria).toEqual([]);
      expect(story?.criterionAmendments?.[0].original).toBe(FDFT_ORIGINAL);
    });

    it('rejects a replacement on a supersession', () => {
      writeSamplePrd();
      const result = supersedeCriterion(testDir, 'US-001', {
        original: FDFT_ORIGINAL,
        ...amendmentBase,
        replacement: FDFT_REPLACEMENT,
      });
      expect(result).toEqual({ ok: false, error: 'replacement-not-allowed' });
    });
  });

  describe('strict validation', () => {
    it('returns story-not-found for an unknown story', () => {
      writeSamplePrd();
      expect(amendCriterion(testDir, 'US-999', {
        original: FDFT_ORIGINAL,
        replacement: FDFT_REPLACEMENT,
        ...amendmentBase,
      })).toEqual({ ok: false, error: 'story-not-found' });
    });

    it('returns prd-not-found when no PRD exists', () => {
      expect(amendCriterion(testDir, 'US-001', {
        original: FDFT_ORIGINAL,
        replacement: FDFT_REPLACEMENT,
        ...amendmentBase,
      })).toEqual({ ok: false, error: 'prd-not-found' });
    });

    it('returns original-not-active when the criterion is not active', () => {
      writeSamplePrd();
      expect(amendCriterion(testDir, 'US-001', {
        original: 'Some inactive criterion',
        replacement: 'Replacement',
        ...amendmentBase,
      })).toEqual({ ok: false, error: 'original-not-active' });
    });

    it('requires a non-empty reason', () => {
      writeSamplePrd();
      expect(amendCriterion(testDir, 'US-001', {
        original: FDFT_ORIGINAL,
        replacement: FDFT_REPLACEMENT,
        ...amendmentBase,
        reason: '   ',
      })).toEqual({ ok: false, error: 'reason-required' });
    });

    it('requires non-empty evidence', () => {
      writeSamplePrd();
      expect(amendCriterion(testDir, 'US-001', {
        original: FDFT_ORIGINAL,
        replacement: FDFT_REPLACEMENT,
        ...amendmentBase,
        evidence: '',
      })).toEqual({ ok: false, error: 'evidence-required' });
    });

    it('enforces bounded proof via a minimum evidence length', () => {
      writeSamplePrd();
      expect(amendCriterion(testDir, 'US-001', {
        original: FDFT_ORIGINAL,
        replacement: FDFT_REPLACEMENT,
        ...amendmentBase,
        evidence: 'short',
      })).toEqual({ ok: false, error: 'evidence-too-short' });
      expect(MIN_CRITERION_EVIDENCE_LENGTH).toBe(10);
    });

    it('requires an authority', () => {
      writeSamplePrd();
      expect(amendCriterion(testDir, 'US-001', {
        original: FDFT_ORIGINAL,
        replacement: FDFT_REPLACEMENT,
        ...amendmentBase,
        authority: '',
      })).toEqual({ ok: false, error: 'authority-required' });
    });

    it('requires a replacement for amendCriterion', () => {
      writeSamplePrd();
      expect(amendCriterion(testDir, 'US-001', {
        original: FDFT_ORIGINAL,
        ...amendmentBase,
      })).toEqual({ ok: false, error: 'replacement-required' });
    });

    it('cannot amend a criterion more than once (the original is no longer active)', () => {
      writeSamplePrd();
      amendCriterion(testDir, 'US-001', {
        original: FDFT_ORIGINAL,
        replacement: FDFT_REPLACEMENT,
        ...amendmentBase,
      });

      const second = amendCriterion(testDir, 'US-001', {
        original: FDFT_ORIGINAL,
        replacement: 'A different correction',
        ...amendmentBase,
      });
      // The amended original left the active list, so a second amendment is rejected.
      expect(second).toEqual({ ok: false, error: 'original-not-active' });
      // The ledger records exactly one amendment; the active list is untouched.
      const story = readPrd(testDir)?.userStories[0];
      expect(story?.criterionAmendments).toHaveLength(1);
      expect(story?.acceptanceCriteria).toEqual([FDFT_REPLACEMENT]);
    });

    it('never mutates the PRD on validation failure', () => {
      writeSamplePrd();
      amendCriterion(testDir, 'US-001', {
        original: FDFT_ORIGINAL,
        replacement: FDFT_REPLACEMENT,
        ...amendmentBase,
        evidence: 'short',
      });

      const story = readPrd(testDir)?.userStories[0];
      expect(story?.acceptanceCriteria).toEqual([FDFT_ORIGINAL]);
      expect(story?.criterionAmendments).toBeUndefined();
    });
  });

  describe('fail-closed normalization invariants', () => {
    it('rejects an amendment record with a missing proof field', () => {
      const prd: PRD = {
        ...samplePrd,
        userStories: [
          {
            ...samplePrd.userStories[0],
            acceptanceCriteria: [FDFT_REPLACEMENT],
            criterionAmendments: [
              { ...resultAmendment(), evidence: undefined as unknown as string },
            ],
          },
        ],
      };
      writeSamplePrd(prd);
      expect(readPrd(testDir)).toBeNull();
    });

    it('rejects an active criterion that is also an amended original (contradictory ledger)', () => {
      const prd: PRD = {
        ...samplePrd,
        userStories: [
          {
            ...samplePrd.userStories[0],
            acceptanceCriteria: [FDFT_ORIGINAL, FDFT_REPLACEMENT],
            criterionAmendments: [resultAmendment()],
          },
        ],
      };
      writeSamplePrd(prd);
      expect(readPrd(testDir)).toBeNull();
    });

    it('rejects a duplicated amendment original', () => {
      const prd: PRD = {
        ...samplePrd,
        userStories: [
          {
            ...samplePrd.userStories[0],
            acceptanceCriteria: [],
            criterionAmendments: [resultAmendment(), resultAmendment()],
          },
        ],
      };
      writeSamplePrd(prd);
      expect(readPrd(testDir)).toBeNull();
    });

    it('rejects kind replaced without a replacement', () => {
      const prd: PRD = {
        ...samplePrd,
        userStories: [
          {
            ...samplePrd.userStories[0],
            acceptanceCriteria: [],
            criterionAmendments: [
              {
                kind: 'replaced',
                original: FDFT_ORIGINAL,
                reason: amendmentBase.reason,
                evidence: amendmentBase.evidence,
                authority: amendmentBase.authority,
                timestamp: amendmentBase.timestamp,
              },
            ],
          },
        ],
      };
      writeSamplePrd(prd);
      expect(readPrd(testDir)).toBeNull();
    });

    it('rejects kind superseded with a replacement', () => {
      const prd: PRD = {
        ...samplePrd,
        userStories: [
          {
            ...samplePrd.userStories[0],
            acceptanceCriteria: [],
            criterionAmendments: [
              {
                kind: 'superseded',
                original: FDFT_ORIGINAL,
                replacement: FDFT_REPLACEMENT,
                reason: amendmentBase.reason,
                evidence: amendmentBase.evidence,
                authority: amendmentBase.authority,
                timestamp: amendmentBase.timestamp,
              },
            ],
          },
        ],
      };
      writeSamplePrd(prd);
      expect(readPrd(testDir)).toBeNull();
    });

    it('treats an empty amendment array as absent (backward compatible)', () => {
      const prd: PRD = {
        ...samplePrd,
        userStories: [
          {
            ...samplePrd.userStories[0],
            acceptanceCriteria: [FDFT_ORIGINAL],
            criterionAmendments: [],
          },
        ],
      };
      writeSamplePrd(prd);
      const story = readPrd(testDir)?.userStories[0];
      expect(story?.acceptanceCriteria).toEqual([FDFT_ORIGINAL]);
      expect(story?.criterionAmendments).toBeUndefined();
    });
  });

  describe('backward compatibility', () => {
    it('reads and writes a legacy PRD without amendments unchanged', () => {
      writeSamplePrd();

      const story = readPrd(testDir)?.userStories[0];
      expect(story?.acceptanceCriteria).toEqual([FDFT_ORIGINAL]);
      expect(story?.criterionAmendments).toBeUndefined();
      expect(readPrd(testDir)).toEqual(samplePrd);
    });

    it('keeps formatting identical for stories without amendments', () => {
      const story = samplePrd.userStories[0];
      expect(formatCriterionAmendments(story)).toBe('');
      expect(formatStory(story)).toContain(FDFT_ORIGINAL);
      expect(formatStory(story)).not.toContain('evidence ledger');
      expect(formatPrd(samplePrd)).toContain(FDFT_ORIGINAL);
      expect(formatPrd(samplePrd)).not.toContain('~~');
    });

    it('preserves amendments when a story is created through createPrd', () => {
      const prd = createPrd('Project', 'branch', 'Description', [
        {
          id: 'US-001',
          title: 'A',
          description: '',
          acceptanceCriteria: [FDFT_REPLACEMENT],
          criterionAmendments: [resultAmendment()],
        },
      ]);
      expect(prd.userStories[0].criterionAmendments).toEqual([resultAmendment()]);
    });
  });

  describe('completion semantics', () => {
    it('invalidates completed and verified stories for replacements and supersessions', () => {
      writeSamplePrd({
        ...samplePrd,
        userStories: [{ ...samplePrd.userStories[0], passes: true, architectVerified: true }],
      });
      expect(amendCriterion(testDir, 'US-001', {
        original: FDFT_ORIGINAL,
        replacement: FDFT_REPLACEMENT,
        ...amendmentBase,
      }).ok).toBe(true);

      let story = readPrd(testDir)?.userStories[0];
      expect(story).toMatchObject({ passes: false, architectVerified: false });
      expect(story?.criterionAmendments).toEqual([resultAmendment()]);
      expect(getPrdStatus(readPrd(testDir)!)).toMatchObject({
        allComplete: false,
        incompleteIds: ['US-001'],
      });

      expect(markStoryComplete(testDir, 'US-001')).toBe(true);
      expect(supersedeCriterion(testDir, 'US-001', {
        original: FDFT_REPLACEMENT,
        ...amendmentBase,
        timestamp: '2026-08-10T03:16:00.000Z',
      }).ok).toBe(true);

      story = readPrd(testDir)?.userStories[0];
      expect(story).toMatchObject({ passes: false, architectVerified: false, acceptanceCriteria: [] });
      expect(story?.criterionAmendments).toHaveLength(2);
      expect(story?.criterionAmendments?.map(amendment => amendment.original)).toEqual([
        FDFT_ORIGINAL,
        FDFT_REPLACEMENT,
      ]);
    });

    it('clears stale architect verification on an already incomplete story', () => {
      writeSamplePrd({
        ...samplePrd,
        userStories: [{ ...samplePrd.userStories[0], passes: false, architectVerified: true }],
      });

      expect(supersedeCriterion(testDir, 'US-001', { original: FDFT_ORIGINAL, ...amendmentBase }).ok).toBe(true);
      expect(readPrd(testDir)?.userStories[0]).toMatchObject({
        passes: false,
        architectVerified: false,
        acceptanceCriteria: [],
      });
    });

    it('invalidates a completed and verified story when its criterion is superseded', () => {
      writeSamplePrd({
        ...samplePrd,
        userStories: [{ ...samplePrd.userStories[0], passes: true, architectVerified: true }],
      });

      expect(supersedeCriterion(testDir, 'US-001', { original: FDFT_ORIGINAL, ...amendmentBase }).ok).toBe(true);

      const prd = readPrd(testDir)!;
      expect(prd.userStories[0]).toMatchObject({ passes: false, architectVerified: false, acceptanceCriteria: [] });
      expect(prd.userStories[0].criterionAmendments).toHaveLength(1);
      expect(getPrdStatus(prd)).toMatchObject({ allComplete: false, incompleteIds: ['US-001'] });
    });

    it('a superseded criterion no longer blocks completion while the ledger records why', () => {
      writeSamplePrd();
      supersedeCriterion(testDir, 'US-001', { original: FDFT_ORIGINAL, ...amendmentBase });

      expect(markStoryComplete(testDir, 'US-001', 'Classification done')).toBe(true);
      const story = readPrd(testDir)?.userStories[0];
      expect(story?.passes).toBe(true);
      expect(story?.criterionAmendments?.[0].original).toBe(FDFT_ORIGINAL);
      // Completion still gates on architect verification; the ledger is preserved.
      const status = getPrdStatus(readPrd(testDir)!);
      expect(status.allComplete).toBe(false);
    });
  });

  describe('formatting and prompts', () => {
    const amendedStory: UserStory = {
      id: 'US-001',
      title: 'Classify setters',
      description: 'Classify every file that sets FDFT_WHALE_STREAM=1',
      acceptanceCriteria: [FDFT_REPLACEMENT],
      criterionAmendments: [resultAmendment()],
      priority: 1,
      passes: false,
      architectVerified: false,
    };

    it('formats the ledger with a struck-through original and proof', () => {
      const rendered = formatCriterionAmendments(amendedStory);
      expect(rendered).toContain(`~~${FDFT_ORIGINAL}~~`);
      expect(rendered).toContain(FDFT_REPLACEMENT);
      expect(rendered).toContain(amendmentBase.reason);
      expect(rendered).toContain(amendmentBase.evidence);
      expect(rendered).toContain(amendmentBase.authority);
      expect(rendered).toContain(amendmentBase.timestamp);
    });

    it('formatStory surfaces the ledger under the active criteria', () => {
      const rendered = formatStory(amendedStory);
      expect(rendered).toContain(FDFT_REPLACEMENT);
      expect(rendered).toContain(`~~${FDFT_ORIGINAL}~~`);
      expect(rendered).toContain('evidence ledger');
    });

    it('formatNextStoryPrompt includes the ledger and the amend instruction', () => {
      const rendered = formatNextStoryPrompt(amendedStory, join(testDir, 'prd.json'));
      expect(rendered).toContain(FDFT_REPLACEMENT);
      expect(rendered).toContain(`~~${FDFT_ORIGINAL}~~`);
      expect(rendered).toContain('amend or supersede it with evidence');
      expect(rendered).toContain('Active PRD file');
    });

    it('the architect verification prompt surfaces the amendment ledger', () => {
      const verificationState: VerificationState = {
        pending: true,
        completion_claim: 'Classification complete',
        verification_attempts: 0,
        max_verification_attempts: 3,
        requested_at: new Date().toISOString(),
        original_task: 'Classify FDFT_WHALE_STREAM usage',
        story_id: 'US-001',
      };

      const prompt = getArchitectVerificationPrompt(verificationState, amendedStory);
      expect(prompt).toContain(FDFT_REPLACEMENT);
      expect(prompt).toContain(`~~${FDFT_ORIGINAL}~~`);
      expect(prompt).toContain('Amended/Superseded Criteria');
      expect(prompt).toContain(amendmentBase.evidence);
    });
  });
});
