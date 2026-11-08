import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkPersistentModes } from '../index.js';
import { getStoryGoverningCriteriaRevision, readPrd, writePrd as writeRawPrd, type PRD } from '../../ralph/prd.js';
import { setCurrentStory } from '../../ralph/loop.js';

/**
 * [CC] writes the session transcript to
 * `<CLAUDE_CONFIG_DIR>/projects/<slug>/<sessionId>.jsonl` and hands the path to
 * hooks as `transcript_path`. Nothing in OMC writes
 * `<CLAUDE_CONFIG_DIR>/sessions/<sessionId>/messages.json`, so approval
 * detection that only reads the legacy path can never see a reviewer verdict —
 * `architectVerified` stays false forever and Ralph never terminates on its
 * own. These tests pin the payload path and the widened scan window.
 */
describe('Ralph architect approval via the Stop payload transcript', () => {
  let testDir: string;
  let claudeConfigDir: string;
  let originalClaudeConfigDir: string | undefined;

  beforeEach(() => {
    testDir = join(tmpdir(), `ralph-approval-transcript-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    claudeConfigDir = join(testDir, '.fake-claude');
    mkdirSync(testDir, { recursive: true });
    mkdirSync(claudeConfigDir, { recursive: true });
    execSync('git init', { cwd: testDir });

    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  });

  afterEach(() => {
    if (originalClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    }
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function sessionDir(sessionId: string): string {
    return join(testDir, '.omc', 'state', 'sessions', sessionId);
  }

  function writeRalphState(sessionId: string): void {
    const dir = sessionDir(sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ralph-state.json'), JSON.stringify({
      active: true,
      iteration: 2,
      max_iterations: 10,
      session_id: sessionId,
      started_at: new Date().toISOString(),
      prompt: 'Finish the stories',
    }));
  }

  function writeStoryVerification(
    sessionId: string,
    storyId: string,
    requestId: string,
    criteriaRevision: string,
    requestedAt = new Date().toISOString(),
  ): void {
    const dir = sessionDir(sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ralph-verification-state.json'), JSON.stringify({
      pending: true,
      completion_claim: `Story ${storyId} is complete`,
      verification_attempts: 0,
      max_verification_attempts: 3,
      requested_at: requestedAt,
      original_task: 'Finish the stories',
      verification_scope: 'story',
      story_id: storyId,
      critic_mode: 'architect',
      request_id: requestId,
      criteria_revision: criteriaRevision,
    }));
  }

  /** Transcript at the location [CC] actually writes, returned as a hook payload path. */
  function writeProjectTranscript(sessionId: string, entries: unknown[]): string {
    const projectDir = join(claudeConfigDir, 'projects', '-tmp-project');
    mkdirSync(projectDir, { recursive: true });
    const transcriptPath = join(projectDir, `${sessionId}.jsonl`);
    writeFileSync(transcriptPath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    return transcriptPath;
  }

  function reviewerTurn(
    requestId: string,
    storyId: string,
    reviewerTool = 'Task',
  ): unknown[] {
    const approval = `<ralph-approved critic="architect" request-id="${requestId}" story-id="${storyId}">VERIFIED_COMPLETE</ralph-approved>`;
    return [
      {
        timestamp: '2026-04-13T12:00:00.000Z',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'toolu-review',
            name: reviewerTool,
            input: { subagent_type: 'architect' },
          }],
        },
      },
      {
        timestamp: '2026-04-13T12:00:05.000Z',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu-review',
            content: [{ type: 'text', text: approval }],
          }],
        },
      },
    ];
  }

  function reviewerRejectionTurn(
    text: string,
    at: string,
    reviewerTool = 'Task',
  ): unknown[] {
    return [
      {
        timestamp: at,
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'toolu-review',
            name: reviewerTool,
            input: { subagent_type: 'architect' },
          }],
        },
      },
      {
        timestamp: at,
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu-review',
            content: [{ type: 'text', text }],
          }],
        },
      },
    ];
  }

  function writeStoryPrd(sessionId: string, storyId: string): string {
    const prd: PRD = {
      project: 'Test',
      branchName: 'ralph/test',
      description: 'Test PRD',
      userStories: [{
        id: storyId,
        title: 'Story',
        description: 'Story under review',
        acceptanceCriteria: ['Feature is implemented'],
        priority: 1,
        passes: true,
        architectVerified: false,
      }],
    };
    for (const story of prd.userStories) {
      if (!story.passes) continue;
      const revision = getStoryGoverningCriteriaRevision(story);
      story.completionCriteriaRevision = revision;
      if (story.architectVerified) story.architectVerificationCriteriaRevision = revision;
    }
    expect(writeRawPrd(testDir, prd, sessionId)).toBe(true);
    return getStoryGoverningCriteriaRevision(prd.userStories[0]!);
  }

  function storyVerified(sessionId: string, storyId: string): boolean {
    const prd = readPrd(testDir, sessionId);
    const story = prd?.userStories.find((candidate) => candidate.id === storyId);
    if (!story) return false;
    return story.architectVerified === true
      && story.architectVerificationCriteriaRevision === getStoryGoverningCriteriaRevision(story);
  }

  function storyPasses(sessionId: string, storyId: string): boolean {
    const prd = readPrd(testDir, sessionId);
    return prd?.userStories.find((candidate) => candidate.id === storyId)?.passes === true;
  }

  function prepare(
    sessionId: string,
    storyId: string,
    requestId: string,
    requestedAt = new Date().toISOString(),
  ): void {
    writeRalphState(sessionId);
    expect(setCurrentStory(testDir, storyId, sessionId)).toBe(true);
    const revision = writeStoryPrd(sessionId, storyId);
    writeStoryVerification(sessionId, storyId, requestId, revision, requestedAt);
  }

  it('binds the approval from the payload transcript_path and sets architectVerified', async () => {
    const sessionId = 'ralph-payload-transcript';
    const storyId = 'US-001';
    prepare(sessionId, storyId, 'request-payload');
    const transcriptPath = writeProjectTranscript(sessionId, reviewerTurn('request-payload', storyId));

    await checkPersistentModes(sessionId, testDir, { transcript_path: transcriptPath });

    expect(storyVerified(sessionId, storyId)).toBe(true);
  });

  it('finds an approval that sits further back than the 32 KB tail window', async () => {
    const sessionId = 'ralph-far-approval';
    const storyId = 'US-001';
    prepare(sessionId, storyId, 'request-far');

    // The reviewer verdict arrives, then the agent keeps working for many turns
    // before the next Stop event. A 32 KB tail would no longer contain it.
    const padding = Array.from({ length: 400 }, (_, index) => ({
      timestamp: `2026-04-13T12:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'x'.repeat(200) }],
      },
    }));
    const transcriptPath = writeProjectTranscript(sessionId, [
      ...reviewerTurn('request-far', storyId),
      ...padding,
    ]);

    await checkPersistentModes(sessionId, testDir, { transcript_path: transcriptPath });

    expect(storyVerified(sessionId, storyId)).toBe(true);
  });

  it('ignores an approval tag that did not come from the reviewer', async () => {
    const sessionId = 'ralph-forged-approval';
    const storyId = 'US-001';
    prepare(sessionId, storyId, 'request-forged');

    // Same tag, but produced by a Bash tool result rather than the reviewer
    // subagent. Widening the scan window must not widen who can approve.
    const transcriptPath = writeProjectTranscript(
      sessionId,
      reviewerTurn('request-forged', storyId, 'Bash'),
    );

    const result = await checkPersistentModes(sessionId, testDir, { transcript_path: transcriptPath });

    expect(storyVerified(sessionId, storyId)).toBe(false);
    expect(result.shouldBlock).toBe(true);
  });

  it('still reads the legacy messages.json path when no transcript_path is supplied', async () => {
    const sessionId = 'ralph-legacy-path';
    const storyId = 'US-001';
    prepare(sessionId, storyId, 'request-legacy');

    const legacyDir = join(claudeConfigDir, 'sessions', sessionId);
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, 'messages.json'),
      `${reviewerTurn('request-legacy', storyId).map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    );

    await checkPersistentModes(sessionId, testDir);

    expect(storyVerified(sessionId, storyId)).toBe(true);
  });

  it('does not treat an approval for an earlier request as current', async () => {
    const sessionId = 'ralph-stale-approval';
    const storyId = 'US-001';
    prepare(sessionId, storyId, 'request-current');

    const transcriptPath = writeProjectTranscript(sessionId, reviewerTurn('request-old', storyId));

    await checkPersistentModes(sessionId, testDir, { transcript_path: transcriptPath });

    expect(storyVerified(sessionId, storyId)).toBe(false);
  });

  it('applies a rejection the reviewer issued for the current request', async () => {
    const sessionId = 'ralph-current-rejection';
    const storyId = 'US-002';
    const requestedAt = '2026-04-13T12:00:00.000Z';
    prepare(sessionId, storyId, 'request-current-rejection', requestedAt);

    const transcriptPath = writeProjectTranscript(
      sessionId,
      reviewerRejectionTurn('Architect: issues found in the ledger rendering.', '2026-04-13T12:00:05.000Z'),
    );

    await checkPersistentModes(sessionId, testDir, { transcript_path: transcriptPath });

    expect(storyPasses(sessionId, storyId)).toBe(false);
  });

  it('applies rejection wording that has no trigger word beyond "not yet complete"', async () => {
    const sessionId = 'ralph-not-yet-complete';
    const storyId = 'US-002';
    const requestedAt = '2026-04-13T12:00:00.000Z';
    prepare(sessionId, storyId, 'request-not-yet-complete', requestedAt);

    // detectArchitectRejection() accepts this wording; the transcript
    // prefilter has to be a superset of its patterns or the verdict is skipped.
    const transcriptPath = writeProjectTranscript(
      sessionId,
      reviewerRejectionTurn('Architect: not yet complete.', '2026-04-13T12:00:05.000Z'),
    );

    await checkPersistentModes(sessionId, testDir, { transcript_path: transcriptPath });

    expect(storyPasses(sessionId, storyId)).toBe(false);
  });

  it('ignores a rejection left over from an earlier story', async () => {
    const sessionId = 'ralph-old-rejection';
    const storyId = 'US-002';
    const requestedAt = '2026-04-13T12:00:00.000Z';
    prepare(sessionId, storyId, 'request-after-old-rejection', requestedAt);

    // US-001's rejection is still inside the scanned window, but it predates
    // this request. Applying it would mark the pending US-002 incomplete.
    const transcriptPath = writeProjectTranscript(
      sessionId,
      reviewerRejectionTurn('Architect: issues found in the US-001 ledger.', '2026-04-13T11:00:00.000Z'),
    );

    await checkPersistentModes(sessionId, testDir, { transcript_path: transcriptPath });

    expect(storyPasses(sessionId, storyId)).toBe(true);
  });

  it('ignores rejection wording that did not come from the reviewer', async () => {
    const sessionId = 'ralph-forged-rejection';
    const storyId = 'US-002';
    const requestedAt = '2026-04-13T12:00:00.000Z';
    prepare(sessionId, storyId, 'request-forged-rejection', requestedAt);

    // Same wording and time, but produced by a Bash tool result.
    const transcriptPath = writeProjectTranscript(
      sessionId,
      reviewerRejectionTurn('Architect: issues found.', '2026-04-13T12:00:05.000Z', 'Bash'),
    );

    await checkPersistentModes(sessionId, testDir, { transcript_path: transcriptPath });

    expect(storyPasses(sessionId, storyId)).toBe(true);
  });
});
