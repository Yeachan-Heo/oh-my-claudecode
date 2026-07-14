import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

import { canResumeAutopilot, cancelAutopilot, resumeAutopilot } from '../cancel.js';
import { checkAutopilot } from '../enforcement.js';
import { createWorkflowDescriptor } from '../pipeline.js';
import { initAutopilot, readAutopilotState, writeAutopilotState } from '../state.js';

describe('workflow descriptor integrity enforcement (#3487)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'workflow-integrity-'));
    process.env.CLAUDE_CONFIG_DIR = join(testDir, 'claude-config');
    mkdirSync(join(process.env.CLAUDE_CONFIG_DIR, 'projects'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  it('returns a redacted integrity failure without mutating or advancing profile state', async () => {
    const sessionId = 'workflow-session';
    initAutopilot(testDir, 'ship the release', sessionId);
    const descriptor = createWorkflowDescriptor(
      'release-flow',
      { version: 1, stages: ['ralplan', 'execution'] },
    )!;
    const base = readAutopilotState(testDir, sessionId)!;
    writeAutopilotState(testDir, { ...base, workflow: descriptor }, sessionId);
    const initialized = readAutopilotState(testDir, sessionId)!;
    writeAutopilotState(
      testDir,
      { ...initialized, workflow: { ...initialized.workflow!, profileHash: '0'.repeat(64) } },
      sessionId,
    );
    const tampered = readAutopilotState(testDir, sessionId)!;
    const trackingBefore = tampered.pipelineTracking;

    const result = await checkAutopilot(sessionId, testDir);
    const persisted = readAutopilotState(testDir, sessionId)!;

    expect(result).toEqual({
      shouldBlock: false,
      message: 'workflow_descriptor_integrity_failed',
      phase: 'expansion',
    });
    expect(persisted).toEqual(tampered);
    expect(persisted.active).toBe(true);
    expect(persisted.pipelineTracking).toEqual(trackingBefore);
    expect(canResumeAutopilot(testDir, sessionId)).toEqual({
      canResume: false,
      resumePhase: 'expansion',
      integrityFailed: true,
    });

    expect(cancelAutopilot(testDir, sessionId).success).toBe(true);
    expect(resumeAutopilot(testDir, sessionId)).toMatchObject({
      success: false,
      message: 'workflow_descriptor_integrity_failed',
    });
  });

  it('dispatches a valid named state without legacy mutation', async () => {
    const sessionId = 'named-reader-session';
    const base = initAutopilot(testDir, 'ship the release', sessionId)!;
    const descriptor = createWorkflowDescriptor('release-flow', { version: 1, stages: ['ralplan', 'execution'] })!;
    const transcriptRoot = join(testDir, 'claude-config', 'projects');
    const transcriptPath = join(transcriptRoot, `${sessionId}.jsonl`);
    writeFileSync(transcriptPath, '');
    const stat = statSync(transcriptPath);
    const identity = { device: stat.dev, inode: stat.ino, size: 0, mtimeNs: '0', ctimeNs: '0', contentSha256: createHash('sha256').update('').digest('hex') };
    const boundary = { transcriptPath, transcriptRoot, transcriptBasename: `${sessionId}.jsonl`, sessionId, byteOffset: 0, fileIdentity: identity };
    const namedState = {
      ...base,
      phase: 'ralplan' as const,
      prompt: 'ship the release',
      workflow: descriptor,
      workflowRunId: '11111111-1111-4111-8111-111111111111',
      pipelineTracking: {
        stages: [
          { id: 'ralplan' as const, status: 'active' as const, iterations: 0, startedAt: new Date().toISOString() },
          { id: 'execution' as const, status: 'pending' as const, iterations: 0 },
        ],
        currentStageIndex: 0,
        trackingRevision: 0,
        activationBoundary: boundary,
        completionObservations: [],
      },
    };
    writeAutopilotState(testDir, namedState, sessionId);
    const before = readAutopilotState(testDir, sessionId)!;

    const result = await checkAutopilot(sessionId, testDir);
    expect(result).toMatchObject({ shouldBlock: true, phase: 'ralplan' });
    expect(result?.message).toContain('## PIPELINE STAGE: RALPLAN (Consensus Planning)');
    expect(readAutopilotState(testDir, sessionId)).toEqual(before);

    const malformed = { ...before, pipeline: before.pipelineTracking } as typeof before & { pipeline: unknown };
    delete (malformed as Partial<typeof before>).pipelineTracking;
    writeAutopilotState(testDir, malformed, sessionId);
    await expect(checkAutopilot(sessionId, testDir)).resolves.toEqual({
      shouldBlock: false,
      message: 'workflow_descriptor_integrity_failed',
      phase: 'ralplan',
    });

    const traversal = structuredClone(before);
    traversal.pipelineTracking!.activationBoundary!.transcriptPath = join(transcriptRoot, '..', 'outside', `${sessionId}.jsonl`);
    writeAutopilotState(testDir, traversal, sessionId);
    await expect(checkAutopilot(sessionId, testDir)).resolves.toMatchObject({ shouldBlock: false, message: 'workflow_descriptor_integrity_failed' });

    const wrongBasename = structuredClone(before);
    wrongBasename.pipelineTracking!.activationBoundary!.transcriptPath = join(transcriptRoot, 'other.jsonl');
    writeFileSync(wrongBasename.pipelineTracking!.activationBoundary!.transcriptPath, '');
    writeAutopilotState(testDir, wrongBasename, sessionId);
    await expect(checkAutopilot(sessionId, testDir)).resolves.toMatchObject({ shouldBlock: false, message: 'workflow_descriptor_integrity_failed' });
  });
});
