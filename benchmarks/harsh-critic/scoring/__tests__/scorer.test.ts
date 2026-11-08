import { describe, test, expect } from 'vitest';
import { matchFindings, scoreFixture, aggregateScores } from '../scorer.js';
import type {
  GroundTruth,
  GroundTruthFinding,
  ParsedAgentOutput,
  FixtureResult,
  BenchmarkScores,
} from '../types.js';

// ============================================================
// Helpers
// ============================================================

function makeGroundTruthFinding(overrides: Partial<GroundTruthFinding> = {}): GroundTruthFinding {
  return {
    id: 'F1',
    severity: 'CRITICAL',
    category: 'finding',
    summary: 'Test finding',
    keywords: ['stale', 'validateSession', 'auth'],
    explanation: 'Test explanation',
    ...overrides,
  };
}

function makeGroundTruth(overrides: Partial<GroundTruth> = {}): GroundTruth {
  return {
    fixtureId: 'test-fixture',
    fixturePath: 'fixtures/test.md',
    domain: 'plan',
    expectedVerdict: 'REJECT',
    findings: [makeGroundTruthFinding()],
    isCleanBaseline: false,
    ...overrides,
  };
}

function makeParsedOutput(overrides: Partial<ParsedAgentOutput> = {}): ParsedAgentOutput {
  return {
    verdict: 'REJECT',
    criticalFindings: [],
    majorFindings: [],
    minorFindings: [],
    missingItems: [],
    perspectiveNotes: { security: [], newHire: [], ops: [] },
    hasPreCommitment: true,
    hasGapAnalysis: true,
    hasMultiPerspective: true,
    rawOutput: '',
    ...overrides,
  };
}

function makeFixtureResult(overrides: Partial<FixtureResult> = {}): FixtureResult {
  return {
    fixtureId: 'test-fixture',
    domain: 'plan',
    agentType: 'harsh-critic',
    parsedOutput: makeParsedOutput(),
    scores: {
      truePositiveRate: 0.5,
      falsePositiveRate: 0.2,
      falseNegativeRate: 0.5,
      severityAccuracy: 0.8,
      missingCoverage: 0.6,
      perspectiveCoverage: 0.5,
      evidenceRate: 0.7,
      hasPreCommitment: true,
      hasMultiPerspective: true,
      hasGapAnalysis: true,
      compositeScore: 0.65,
    },
    matchedFindings: ['F1'],
    missedFindings: [],
    spuriousFindings: [],
    ...overrides,
  };
}

// ============================================================
// Tests
// ============================================================

describe('matchFindings', () => {
  test('matches agent finding to ground truth by keyword overlap', () => {
    const gt = makeGroundTruth();
    const parsed = makeParsedOutput({
      criticalFindings: [
        {
          text: 'Stale function reference: validateSession() at auth.ts:42',
          severity: 'CRITICAL',
          hasEvidence: true,
        },
      ],
    });

    const result = matchFindings(parsed, gt);
    expect(result.matchedIds).toContain('F1');
    expect(result.missedIds).toHaveLength(0);
  });

  test('reports missed findings when no keyword overlap', () => {
    const gt = makeGroundTruth();
    const parsed = makeParsedOutput({
      criticalFindings: [
        {
          text: 'Completely unrelated finding about database indexing',
          severity: 'CRITICAL',
          hasEvidence: false,
        },
      ],
    });

    const result = matchFindings(parsed, gt);
    expect(result.matchedIds).toHaveLength(0);
    expect(result.missedIds).toContain('F1');
  });

  test('reports spurious findings that do not match ground truth', () => {
    const gt = makeGroundTruth({ findings: [] });
    const parsed = makeParsedOutput({
      criticalFindings: [
        {
          text: 'Some spurious finding',
          severity: 'CRITICAL',
          hasEvidence: false,
        },
      ],
    });

    const result = matchFindings(parsed, gt);
    expect(result.spuriousTexts).toHaveLength(1);
  });

  // --- PR #1300: scorer calibration tests ---

  test('matching is robust to punctuation and hyphen variants', () => {
    const gt = makeGroundTruth({
      findings: [
        makeGroundTruthFinding({
          id: 'F1',
          keywords: ['new-hire', 'sameSite', 'cookie', 'csrf'],
        }),
      ],
    });

    const parsed = makeParsedOutput({
      criticalFindings: [
        {
          text: 'New hire note: session cookie is missing SameSite and enables CSRF risk.',
          severity: 'CRITICAL',
          hasEvidence: false,
        },
      ],
    });

    const result = matchFindings(parsed, gt);
    expect(result.matchedIds).toContain('F1');
  });

  test('requires 3 keyword matches when ground truth has 6 keywords', () => {
    const gt = makeGroundTruth({
      findings: [
        makeGroundTruthFinding({
          id: 'F1',
          keywords: ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'],
        }),
      ],
    });

    const parsed = makeParsedOutput({
      criticalFindings: [
        {
          text: 'alpha bravo issue only',
          severity: 'CRITICAL',
          hasEvidence: false,
        },
      ],
    });

    const result = matchFindings(parsed, gt);
    expect(result.matchedIds).toHaveLength(0);
    expect(result.missedIds).toContain('F1');
  });

  test('matches 6-keyword ground truth when 3 keywords overlap', () => {
    const gt = makeGroundTruth({
      findings: [
        makeGroundTruthFinding({
          id: 'F1',
          keywords: ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'],
        }),
      ],
    });

    const parsed = makeParsedOutput({
      criticalFindings: [
        {
          text: 'alpha bravo charlie issue is confirmed',
          severity: 'CRITICAL',
          hasEvidence: false,
        },
      ],
    });

    const result = matchFindings(parsed, gt);
    expect(result.matchedIds).toContain('F1');
  });
});

describe('scoreFixture', () => {
  test('computes all score fields', () => {
    const gt = makeGroundTruth();
    const parsed = makeParsedOutput({
      criticalFindings: [
        {
          text: 'Stale function reference: validateSession() at auth.ts:42',
          severity: 'CRITICAL',
          hasEvidence: true,
        },
      ],
    });

    const scores = scoreFixture(parsed, gt);
    expect(scores.truePositiveRate).toBe(1);
    expect(scores.falseNegativeRate).toBe(0);
    expect(scores.compositeScore).toBeGreaterThan(0);
  });

  test('returns zero scores for empty output vs ground truth', () => {
    const gt = makeGroundTruth();
    const parsed = makeParsedOutput();

    const scores = scoreFixture(parsed, gt);
    expect(scores.truePositiveRate).toBe(0);
    expect(scores.falseNegativeRate).toBe(1);
  });
});

describe('aggregateScores', () => {
  test('averages numeric scores across fixture results', () => {
    const r1 = makeFixtureResult({
      scores: { ...makeFixtureResult().scores, truePositiveRate: 0.8 },
    });
    const r2 = makeFixtureResult({
      scores: { ...makeFixtureResult().scores, truePositiveRate: 0.4 },
    });

    const agg = aggregateScores([r1, r2]);
    expect(agg.truePositiveRate).toBeCloseTo(0.6);
  });

  test('returns zero scores for empty results array', () => {
    const agg = aggregateScores([]);
    expect(agg.compositeScore).toBe(0);
    expect(agg.truePositiveRate).toBe(0);
  });
});
