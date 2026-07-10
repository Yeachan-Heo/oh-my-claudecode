import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatMergeReadinessArtifact,
  formatRuntimeMergeReadinessArtifact,
  getMergeReadinessArtifactPath,
  writeMergeReadinessArtifact,
  writeRuntimeMergeReadinessArtifact,
} from '../merge-readiness.js';
import type { MergeReadinessEvidence } from '../merge-readiness.js';

describe('merge readiness artifacts', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'omc-merge-readiness-'));
    tempDirs.push(dir);
    return dir;
  }

  it('formats the explanation, quiz, result, and non-approval boundary', () => {
    const body = formatMergeReadinessArtifact({
      slug: 'auth-change',
      why: 'Reduce unclear merge approvals.',
      whatChanged: 'Added a post-QA explainability gate.',
      tradeoffs: 'Adds a human checkpoint but keeps tests and review separate.',
      risksConsidered: 'Avoids treating quiz pass as approval.',
      teamUnderstanding: 'The team should read this as merge readiness evidence.',
      questions: [
        {
          question: 'Why did we add this gate?',
          expectedAnswerFocus: 'Explainability before merge readiness.',
        },
      ],
      result: 'paused',
    });

    expect(body).toContain('## Why');
    expect(body).toContain('## What Changed');
    expect(body).toContain('## Tradeoffs');
    expect(body).toContain('## Risks Considered');
    expect(body).toContain('## Team Understanding');
    expect(body).toContain('## Human Quiz');
    expect(body).toContain('Expected answer focus: Explainability before merge readiness.');
    expect(body).toContain('## Result');
    expect(body).toContain('paused');
    expect(body).toContain('It does not approve merge, replace tests, replace review');
  });

  it('writes a persistent descriptor under merge-readiness artifacts', () => {
    const tempDir = makeTempDir();
    const descriptor = writeMergeReadinessArtifact(tempDir, {
      slug: 'auth-change',
      why: 'Why text',
      whatChanged: 'What text',
      tradeoffs: 'Tradeoff text',
      risksConsidered: 'Risk text',
      teamUnderstanding: 'Team text',
      questions: [],
      result: 'pass',
      createdAt: '2026-07-09T05:00:00.000Z',
    });

    expect(descriptor.kind).toBe('merge-readiness');
    expect(descriptor.producer).toEqual({ system: 'omc', component: 'merge-readiness' });
    expect(descriptor.retention).toBe('persistent');
    expect(descriptor.path).toContain(join('.omc', 'artifacts', 'merge-readiness'));
    expect(descriptor.path).toBe(
      getMergeReadinessArtifactPath(tempDir, 'auth-change', new Date('2026-07-09T05:00:00.000Z')),
    );
    expect(readFileSync(descriptor.path, 'utf-8')).toContain('_No questions recorded._');
  });

  it('formats the runtime artifact with 5 narrative sections, MCQ transcript, readiness, and merge boundary', () => {
    const evidence: MergeReadinessEvidence = {
      changedFiles: ['src/auth.ts'],
      status: ' M src/auth.ts',
      diffStat: ' src/auth.ts | 4 +-\n',
      sourceArtifacts: [],
      testEvidence: [],
      reviewEvidence: [],
      missingEvidence: [],
    };
    const body = formatRuntimeMergeReadinessArtifact({
      slug: 'auth-change',
      changeSummary: 'Tighten session refresh',
      evidence,
      rounds: [],
      result: 'pass',
      readinessScore: 1,
      dimensionScores: { why: 1, change: 1, tradeoff: 1, risk: 1, team: 1 },
      why: 'Sessions were dropping silently.',
      whatChanged: 'Added inline refresh on 4xx.',
      tradeoffs: 'Extra latency on expired paths vs. background refresh race.',
      risksConsidered: 'Broad 4xx catch; documented not to narrow without upstream check.',
      teamUnderstanding: 'Read as merge-readiness evidence, not approval.',
      threshold: 0.8,
      requiredDimensions: ['why', 'change', 'tradeoff', 'risk', 'team'],
      questions: [
        {
          id: 'q1',
          dimension: 'why',
          stem: 'Why was the refresh added?',
          options: [
            { id: 'a', text: 'Sessions dropped silently.' },
            { id: 'b', text: 'To speed up login.' },
          ],
          correctOptionId: 'a',
        },
      ],
      answers: [
        { questionId: 'q1', selectedOptionId: 'a', isCorrect: true },
      ],
    });

    expect(body).toContain('# Merge Readiness Report');
    expect(body).toContain('## Why');
    expect(body).toContain('Sessions were dropping silently.');
    expect(body).toContain('## What Changed');
    expect(body).toContain('Added inline refresh on 4xx.');
    expect(body).toContain('## Tradeoffs');
    expect(body).toContain('Extra latency on expired paths');
    expect(body).toContain('## Risks Considered');
    expect(body).toContain('Broad 4xx catch');
    expect(body).toContain('## Team Understanding');
    expect(body).toContain('merge-readiness evidence, not approval');
    expect(body).toContain('## Human Explainability Quiz');
    // MCQ transcript marks selected + correct
    expect(body).toContain('_(correct, selected)_');
    expect(body).toContain('Correct: yes');
    expect(body).toContain('## Readiness');
    expect(body).toContain('Result: pass');
    expect(body).toContain('Correctness rate: 100% / threshold 80%');
    expect(body).toContain('## Merge Boundary');
    expect(body).toContain('Passing means the human can explain the change.');
    expect(body).toContain('does not approve merge');
  });

  it('writes a persistent runtime descriptor under merge-readiness artifacts', () => {
    const tempDir = makeTempDir();
    const evidence: MergeReadinessEvidence = {
      changedFiles: [],
      status: '',
      diffStat: '',
      sourceArtifacts: [],
      testEvidence: [],
      reviewEvidence: [],
      missingEvidence: [],
    };
    const descriptor = writeRuntimeMergeReadinessArtifact(tempDir, {
      slug: 'auth-change',
      changeSummary: 'Tighten session refresh',
      evidence,
      rounds: [],
      result: 'paused',
      readinessScore: 0.4,
      dimensionScores: { why: 1, change: 0, tradeoff: 0, risk: 0, team: 0 },
      createdAt: '2026-07-09T05:00:00.000Z',
      why: 'Why',
      whatChanged: 'What',
      tradeoffs: 'Tradeoff',
      risksConsidered: 'Risk',
      teamUnderstanding: 'Team',
      threshold: 0.9,
      requiredDimensions: ['why', 'change', 'tradeoff', 'risk', 'team'],
      questions: [],
      answers: [],
    });

    expect(descriptor.kind).toBe('merge-readiness');
    expect(descriptor.producer).toEqual({ system: 'omc', component: 'merge-readiness-runtime' });
    expect(descriptor.retention).toBe('persistent');
    expect(descriptor.path).toContain(join('.omc', 'artifacts', 'merge-readiness'));
    const body = readFileSync(descriptor.path, 'utf-8');
    expect(body).toContain('## Merge Boundary');
    expect(body).toContain('Result: paused');
  });
});
