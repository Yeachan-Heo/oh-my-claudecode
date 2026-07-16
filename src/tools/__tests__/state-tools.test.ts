import { createHash, randomUUID } from 'crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, existsSync, lstatSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import {
  stateReadTool,
  stateWriteTool,
  stateClearTool,
  stateListActiveTool,
  stateGetStatusTool,
} from '../state-tools.js';
import { emergencyMutateStateFileIf } from '../../lib/mode-state-io.js';

const TEST_DIR = '/tmp/state-tools-test';

// Mock validateWorkingDirectory to allow test directory
vi.mock('../../lib/worktree-paths.js', async () => {
  const actual = await vi.importActual('../../lib/worktree-paths.js');
  return {
    ...actual,
    validateWorkingDirectory: vi.fn((workingDirectory?: string) => {
      return workingDirectory || process.cwd();
    }),
  };
});

function liveLockOwner() {
  const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const processStart = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
  return JSON.stringify({ version: 1, pid: process.pid, processStart, createdAt: new Date().toISOString(), nonce: randomUUID() });
}

function portableWorkflowState(sessionId: string): Record<string, unknown> {
  const transcriptRoot = '/tmp/state-tools-transcripts';
  const fileIdentity = { device: 0, inode: 0, size: 0, mtimeNs: '0', ctimeNs: '0', contentSha256: '0'.repeat(64) };
  const activationBoundary = {
    transcriptPath: `${transcriptRoot}/${sessionId}.jsonl`,
    transcriptRoot,
    transcriptBasename: `${sessionId}.jsonl`,
    sessionId,
    byteOffset: 0,
    fileIdentity,
  };
  const startedAt = '2026-01-01T00:00:00.000Z';
  const stages = ['ralplan', 'execution'];
  return {
    active: true,
    session_id: sessionId,
    prompt: 'private prompt',
    phase: 'ralplan',
    workflowRunId: '11111111-1111-4111-8111-111111111111',
    workflow: {
      descriptorVersion: 1,
      workflowName: 'release-train',
      profileVersion: 1,
      stages,
      profileHash: createHash('sha256').update('{"descriptorVersion":1,"profileVersion":1,"stages":["ralplan","execution"],"workflowName":"release-train"}').digest('hex'),
    },
    pipelineTracking: {
      stages: [{ id: 'ralplan', status: 'active', iterations: 0, startedAt }, { id: 'execution', status: 'pending', iterations: 0 }],
      currentStageIndex: 0,
      trackingRevision: 0,
      activationBoundary,
      completionObservations: [],
    },
  };

}
function completedPortableWorkflowState(sessionId: string): Record<string, unknown> {
  const state = portableWorkflowState(sessionId);
  const tracking = state.pipelineTracking as Record<string, unknown>;
  const initialBoundary = structuredClone(tracking.activationBoundary as Record<string, unknown>);
  const initialIdentity = structuredClone(initialBoundary.fileIdentity as Record<string, unknown>);
  const completedAt = '2026-01-01T00:01:00.000Z';
  const stages = ['ralplan', 'execution'];
  tracking.stages = stages.map((id) => ({ id, status: 'complete', iterations: 0, startedAt: '2026-01-01T00:00:00.000Z', completedAt }));
  tracking.currentStageIndex = stages.length;
  tracking.trackingRevision = stages.length;
  const firstStable = { ...initialIdentity, size: 1, contentSha256: '1'.repeat(64) };
  const secondBoundary = { ...initialBoundary, byteOffset: 1, fileIdentity: firstStable };
  const secondStable = { ...firstStable, size: 2, contentSha256: '2'.repeat(64) };
  tracking.completionObservations = [
    {
      stageId: 'ralplan', sessionId, signalId: 'PIPELINE_RALPLAN_COMPLETE', lineNumber: 0, byteOffset: 0,
      recordContentSha256: '1'.repeat(64), stableFile: firstStable, activationBoundary: initialBoundary, observedAt: completedAt,
    },
    {
      stageId: 'execution', sessionId, signalId: 'PIPELINE_EXECUTION_COMPLETE', lineNumber: 1, byteOffset: 1,
      recordContentSha256: '2'.repeat(64), stableFile: secondStable, activationBoundary: secondBoundary, observedAt: completedAt,
    },
  ];
  tracking.activationBoundary = { ...initialBoundary, byteOffset: 2, fileIdentity: secondStable };
  return { ...state, active: false, phase: 'complete', status: 'private-terminal-status' };
}

describe('state-tools', () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, '.omc', 'state'), { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    delete process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_PATH;
    delete process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_BASE64;
    delete process.env.OMC_TEST_FLOCK_AVAILABLE;
    delete process.env.OMC_TEST_EMERGENCY_CRASH_PHASE;
    delete process.env.OMC_TEST_CONDITIONAL_CREATE_REPLACEMENT_PATH;
    delete process.env.OMC_TEST_CONDITIONAL_CREATE_REPLACEMENT_BASE64;
    delete process.env.OMC_TEST_EMERGENCY_REPLACEMENT_PATH;
    delete process.env.OMC_TEST_EMERGENCY_REPLACEMENT_BASE64;
  });

  describe('state_read', () => {
    it('should return state when file exists at session-scoped path', async () => {
      const sessionId = 'session-read-test';
      const sessionDir = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, 'ralph-state.json'),
        JSON.stringify({ active: true, iteration: 3 })
      );

      const result = await stateReadTool.handler({
        mode: 'ralph',
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('active');
      expect(result.content[0].text).toContain('iteration');
    });

    it('should indicate when no state exists', async () => {
      const result = await stateReadTool.handler({
        mode: 'ultrawork',
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('No state found');
    });
    it('redacts every malformed named marker without exposing private state', async () => {
      const sessionId = 'named-read-redaction';
      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');
      mkdirSync(dirname(statePath), { recursive: true });

      for (const marker of [{ workflow: false }, { workflowRunId: '' }, { pipelineTracking: null }]) {
        writeFileSync(statePath, JSON.stringify({
          active: true,
          session_id: sessionId,
          prompt: 'private prompt',
          transcript: 'private transcript',
          evidence: ['private evidence'],
          workflowRunId: 'private-run-id',
          ...marker,
        }));
        const result = await stateReadTool.handler({ mode: 'autopilot', session_id: sessionId, workingDirectory: TEST_DIR });
        const publicState = JSON.parse(result.content[0].text.match(/```json\n([\s\S]*?)\n```/)![1]);
        expect(publicState).toEqual({
          name: 'invalid',
          version: 1,
          shortHash: 'invalid',
          stages: [],
          currentStage: null,
          status: 'workflow_descriptor_integrity_failed',
          progress: '0/0',
        });
        expect(result.content[0].text).not.toMatch(/private prompt|private transcript|private evidence|private-run-id/);
      }
    });

    it('projects a structurally valid portable named workflow without transcript authentication', async () => {
      const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify(portableWorkflowState(sessionId)));

      const result = await stateReadTool.handler({ mode: 'autopilot', session_id: sessionId, workingDirectory: TEST_DIR });
      const publicState = JSON.parse(result.content[0].text.match(/```json\n([\s\S]*?)\n```/)![1]);
      expect(publicState).toMatchObject({
        name: 'release-train',
        currentStage: 'ralplan',
        progress: '1/2',
      });
      expect(result.content[0].text).not.toContain('private prompt');
    });
    it('uses the public run capability to pause the exact named workflow', async () => {
      const sessionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify(portableWorkflowState(sessionId)));
      process.env.OMC_TEST_FLOCK_AVAILABLE = '0';

      const readResult = await stateReadTool.handler({ mode: 'autopilot', session_id: sessionId, workingDirectory: TEST_DIR });
      const publicState = JSON.parse(readResult.content[0].text.match(/```json\n([\s\S]*?)\n```/)![1]);
      expect(publicState.workflowRunId).toBe('11111111-1111-4111-8111-111111111111');

      const pauseResult = await stateWriteTool.handler({
        mode: 'autopilot',
        active: false,
        state: { workflowRunId: publicState.workflowRunId },
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });
      expect(pauseResult.isError).not.toBe(true);
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
        active: false,
        workflowRunId: publicState.workflowRunId,
      });
    });
    it('derives public status from validated current-stage topology rather than private record status', async () => {
      const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify({ ...portableWorkflowState(sessionId), status: 'private-status' }));

      const result = await stateReadTool.handler({ mode: 'autopilot', session_id: sessionId, workingDirectory: TEST_DIR });
      const publicState = JSON.parse(result.content[0].text.match(/```json\n([\s\S]*?)\n```/)![1]);
      expect(publicState.status).toBe('active');
      expect(result.content[0].text).not.toContain('private-status');
    });

    it('projects terminal named workflows with clamped progress and terminal topology status', async () => {
      const sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify(completedPortableWorkflowState(sessionId)));

      const result = await stateReadTool.handler({ mode: 'autopilot', session_id: sessionId, workingDirectory: TEST_DIR });
      const publicState = JSON.parse(result.content[0].text.match(/```json\n([\s\S]*?)\n```/)![1]);
      expect(publicState).toMatchObject({ currentStage: null, status: 'complete', progress: '2/2' });
      expect(result.content[0].text).not.toContain('private-terminal-status');
    });
  });

  describe('state_write', () => {
    it('should write state to legacy path when no session_id provided', async () => {
      const result = await stateWriteTool.handler({
        mode: 'ralph',
        state: { active: true, iteration: 1 },
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('Successfully wrote');
      const legacyPath = join(TEST_DIR, '.omc', 'state', 'ralph-state.json');
      expect(existsSync(legacyPath)).toBe(true);
    });

    it('should add _meta field to written state', async () => {
      const result = await stateWriteTool.handler({
        mode: 'ralph',
        state: { someField: 'value' },
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('Successfully wrote');
      expect(result.content[0].text).toContain('_meta');
    });

    it('should include session ID in _meta when provided', async () => {
      const sessionId = 'session-meta-test';
      const result = await stateWriteTool.handler({
        mode: 'ralph',
        state: { active: true },
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain(`"sessionId": "${sessionId}"`);
    });
    it('creates a missing generic autopilot pause state', async () => {
      const sessionId = 'missing-generic-pause';
      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');

      const result = await stateWriteTool.handler({
        mode: 'autopilot',
        active: false,
        state: { prompt: 'legacy pause request' },
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
        active: false,
        prompt: 'legacy pause request',
      });
    });

    it('merges a generic legacy autopilot pause without discarding tracking', async () => {
      const sessionId = 'legacy-pause-preserves-state';
      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify({
        active: true,
        session_id: sessionId,
        prompt: 'preserved legacy task',
        pipeline: { currentStageIndex: 0, stages: [{ id: 'ralplan', status: 'active' }] },
      }));

      const result = await stateWriteTool.handler({
        mode: 'autopilot',
        active: false,
        iteration: 4,
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
        active: false,
        iteration: 4,
        prompt: 'preserved legacy task',
        pipeline: { currentStageIndex: 0, stages: [{ id: 'ralplan', status: 'active' }] },
      });
    });
    it('does not let a lock-held Stop be overwritten by state_write cancellation', async () => {
      const sessionId = 'stop-cancel-race';
      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify({ active: true, trackingRevision: 0 }));
      const before = readFileSync(statePath);
      const lockPath = `${statePath}.mutation.lock`;
      writeFileSync(lockPath, liveLockOwner());

      const blocked = await stateWriteTool.handler({ mode: 'autopilot', active: false, session_id: sessionId, workingDirectory: TEST_DIR });
      expect(blocked.isError).toBe(true);
      expect(readFileSync(statePath)).toEqual(before);

      unlinkSync(lockPath);
      const retried = await stateWriteTool.handler({ mode: 'autopilot', active: false, session_id: sessionId, workingDirectory: TEST_DIR });
      expect(retried.isError).not.toBe(true);
      expect(JSON.parse(readFileSync(statePath, 'utf8')).active).toBe(false);
    });

    it('does not clear activation state while its mutation lock is held', async () => {
      const sessionId = 'activation-cleanup-race';
      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');
      await stateWriteTool.handler({ mode: 'autopilot', active: true, session_id: sessionId, workingDirectory: TEST_DIR });
      const lockPath = `${statePath}.mutation.lock`;
      writeFileSync(lockPath, liveLockOwner());

      const blocked = await stateClearTool.handler({ mode: 'autopilot', session_id: sessionId, workingDirectory: TEST_DIR });
      expect(blocked.content[0].text).toMatch(/Warning|No active|Successfully/);
      expect(existsSync(statePath)).toBe(true);

      unlinkSync(lockPath);
      const retried = await stateClearTool.handler({ mode: 'autopilot', session_id: sessionId, workingDirectory: TEST_DIR });
      expect(retried.isError).not.toBe(true);
      expect(existsSync(statePath)).toBe(false);
    });

    it('preserves session and legacy replacements created after cleanup discovery', async () => {
      const sessionId = 'stale-cleanup-owner';
      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');
      await stateWriteTool.handler({ mode: 'autopilot', active: true, session_id: sessionId, workingDirectory: TEST_DIR });
      const replacement = { active: true, session_id: sessionId };
      process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_PATH = statePath;
      process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_BASE64 = Buffer.from(JSON.stringify(replacement)).toString('base64');

      await stateClearTool.handler({ mode: 'autopilot', session_id: sessionId, workingDirectory: TEST_DIR });
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual(replacement);

      const legacyPath = join(TEST_DIR, '.omc', 'state', 'autopilot-state.json');
      writeFileSync(legacyPath, JSON.stringify({ active: true, session_id: sessionId }));
      const legacyReplacement = { active: true, session_id: sessionId, workflowRunId: 'replacement-run' };
      process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_PATH = legacyPath;
      process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_BASE64 = Buffer.from(JSON.stringify(legacyReplacement)).toString('base64');

      await stateClearTool.handler({ mode: 'autopilot', session_id: sessionId, workingDirectory: TEST_DIR });
      expect(JSON.parse(readFileSync(legacyPath, 'utf8'))).toEqual(legacyReplacement);
    });
    it('rejects generic writes to active and paused named workflow state', async () => {
      const sessionId = 'named-safe-write';
      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');
      const namedState = {
        active: true,
        prompt: 'original task',
        session_id: sessionId,
        workflowRunId: '11111111-1111-4111-8111-111111111111',
        workflow: { profileHash: 'a'.repeat(64), stages: ['ralplan'] },
        pipelineTracking: { currentStageIndex: 0, stages: [{ id: 'ralplan', status: 'active' }] },
      };
      mkdirSync(dirname(statePath), { recursive: true });
      for (const active of [true, false]) {
        writeFileSync(statePath, JSON.stringify({ ...namedState, active }));
        const before = readFileSync(statePath);
        const result = await stateWriteTool.handler({ mode: 'autopilot', iteration: 2, state: { prompt: 'different task' }, session_id: sessionId, workingDirectory: TEST_DIR });
        expect(result.isError).toBe(true);
        expect(readFileSync(statePath)).toEqual(before);
      }
    });

    it('linearizes first state_write against a named activation winner', async () => {
      const sessionId = 'named-first-write-race';
      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');
      const namedWinner = { active: true, prompt: 'named task', session_id: sessionId, workflowRunId: '99999999-9999-4999-8999-999999999999', workflow: { profileHash: 'f'.repeat(64), stages: ['ralplan'] }, pipelineTracking: { currentStageIndex: 0, trackingRevision: 0, stages: [{ id: 'ralplan', status: 'active' }] } };
      process.env.OMC_TEST_CONDITIONAL_CREATE_REPLACEMENT_PATH = statePath;
      process.env.OMC_TEST_CONDITIONAL_CREATE_REPLACEMENT_BASE64 = Buffer.from(JSON.stringify(namedWinner)).toString('base64');

      const rejected = await stateWriteTool.handler({ mode: 'autopilot', active: true, state: { prompt: 'legacy task' }, session_id: sessionId, workingDirectory: TEST_DIR });
      expect(rejected.isError).toBe(true);
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual(namedWinner);

      rmSync(statePath, { force: true });
      const firstWriter = await stateWriteTool.handler({ mode: 'autopilot', active: true, state: { prompt: 'legacy task' }, session_id: sessionId, workingDirectory: TEST_DIR });
      expect(firstWriter.isError).toBeUndefined();
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ active: true, prompt: 'legacy task' });
    });
    it('does not overwrite a concurrent named replacement while creating a generic pause state', async () => {
      const sessionId = 'named-pause-create-race';
      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');
      const namedWinner = {
        active: true,
        session_id: sessionId,
        workflowRunId: '99999999-9999-4999-8999-999999999999',
        workflow: { profileHash: 'f'.repeat(64), stages: ['ralplan'] },
        pipelineTracking: { currentStageIndex: 0, trackingRevision: 0, stages: [{ id: 'ralplan', status: 'active' }] },
      };
      process.env.OMC_TEST_CONDITIONAL_CREATE_REPLACEMENT_PATH = statePath;
      process.env.OMC_TEST_CONDITIONAL_CREATE_REPLACEMENT_BASE64 = Buffer.from(JSON.stringify(namedWinner)).toString('base64');

      const result = await stateWriteTool.handler({
        mode: 'autopilot',
        active: false,
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.isError).toBe(true);
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual(namedWinner);
    });

    it('rejects active named workflow identity and tracking mutations without changing bytes', async () => {
      const sessionId = 'named-immutable-write';
      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');
      const namedState = {
        active: true,
        session_id: sessionId,
        workflowRunId: '11111111-1111-4111-8111-111111111111',
        workflow: { profileHash: 'a'.repeat(64), stages: ['ralplan'] },
        pipelineTracking: { currentStageIndex: 0, stages: [{ id: 'ralplan', status: 'active' }] },
      };
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify(namedState));
      const before = readFileSync(statePath);

      for (const mutation of [
        { workflowRunId: '22222222-2222-4222-8222-222222222222' },
        { workflow: { profileHash: 'b'.repeat(64), stages: ['execution'] } },
        { pipelineTracking: { currentStageIndex: 1, stages: [{ id: 'execution', status: 'active' }] } },
      ]) {
        const result = await stateWriteTool.handler({ mode: 'autopilot', state: mutation, session_id: sessionId, workingDirectory: TEST_DIR });
        expect(result.isError).toBe(true);
        expect(readFileSync(statePath)).toEqual(before);
      }
    });

    it('rejects every own named-workflow marker, including falsy partial markers, without changing bytes', async () => {
      const sessionId = 'named-own-marker-write';
      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');
      mkdirSync(dirname(statePath), { recursive: true });
      const markerStates = [
        { workflow: false },
        { workflowRunId: '' },
        { pipelineTracking: null },
        { workflow: { profileHash: 'invalid', stages: [] } },
        {
          workflow: { descriptorVersion: 1, workflowName: 'invalid', profileVersion: 1, profileHash: '0'.repeat(64), stages: ['ralplan', 'execution'] },
          workflowRunId: '11111111-1111-4111-8111-111111111111',
          pipelineTracking: {},
        },
      ];

      for (const status of [
        { active: true },
        { active: false },
        { active: false, phase: 'complete' },
      ]) {
        for (const marker of markerStates) {
          writeFileSync(statePath, JSON.stringify({ ...status, session_id: sessionId, ...marker }));
          const before = readFileSync(statePath);
          const result = await stateWriteTool.handler({
            mode: 'autopilot',
            active: true,
            state: { prompt: 'generic overwrite' },
            session_id: sessionId,
            workingDirectory: TEST_DIR,
          });
          expect(result.isError).toBe(true);
          expect(readFileSync(statePath)).toEqual(before);
        }
      }
      rmSync(statePath, { force: true });
      const markerCreation = await stateWriteTool.handler({
        mode: 'autopilot',
        active: true,
        state: { workflow: false },
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });
      expect(markerCreation.isError).toBe(true);
      expect(existsSync(statePath)).toBe(false);
    });
    it('fails closed when a malformed named marker receives an exact pause request', async () => {
      const sessionId = 'malformed-named-pause';
      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify({
        active: true,
        session_id: sessionId,
        workflowRunId: '11111111-1111-4111-8111-111111111111',
        workflow: false,
      }));
      const before = readFileSync(statePath);

      const result = await stateWriteTool.handler({
        mode: 'autopilot',
        active: false,
        state: { workflowRunId: '11111111-1111-4111-8111-111111111111' },
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.isError).toBe(true);
      expect(readFileSync(statePath)).toEqual(before);
    });
    it('pauses only an authenticated exact named run without flock and preserves every resume field', async () => {
      if (process.platform !== 'linux' || (!existsSync('/usr/bin/flock') && !existsSync('/bin/flock'))) return;
      const sessionId = 'named-resume-pause';
      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');
      const configDir = mkdtempSync(join(tmpdir(), 'state-tools-claude-'));
      const transcript = join(configDir, 'projects', `${sessionId}.jsonl`);
      mkdirSync(dirname(transcript), { recursive: true });
      writeFileSync(transcript, '');
      const stat = lstatSync(transcript, { bigint: true });
      const now = new Date().toISOString();
      const descriptor = { descriptorVersion: 1, workflowName: 'release-flow', profileVersion: 1, stages: ['ralplan', 'execution'] };
      const state = {
        active: true,
        mode: 'autopilot',
        prompt: 'keep this private task',
        phase: 'ralplan',
        session_id: sessionId,
        workflowRunId: '11111111-1111-4111-8111-111111111111',
        workflow: { ...descriptor, profileHash: createHash('sha256').update('{"descriptorVersion":1,"profileVersion":1,"stages":["ralplan","execution"],"workflowName":"release-flow"}').digest('hex') },
        pipelineTracking: {
          stages: [{ id: 'ralplan', status: 'active', iterations: 0, startedAt: now }, { id: 'execution', status: 'pending', iterations: 0 }],
          currentStageIndex: 0,
          trackingRevision: 0,
          activationBoundary: {
            transcriptPath: transcript,
            transcriptRoot: dirname(transcript),
            transcriptBasename: `${sessionId}.jsonl`,
            sessionId,
            byteOffset: 0,
            fileIdentity: { device: Number(stat.dev), inode: Number(stat.ino), size: Number(stat.size), mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString(), contentSha256: createHash('sha256').update(readFileSync(transcript)).digest('hex') },
          },
          completionObservations: [],
        },
      };
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify(state));
      const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
      try {
        process.env.CLAUDE_CONFIG_DIR = configDir;
        process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
        const result = await stateWriteTool.handler({
          mode: 'autopilot',
          active: false,
          state: { workflowRunId: state.workflowRunId, target_state_sha256: createHash('sha256').update(JSON.stringify(state)).digest('hex') },
          session_id: sessionId,
          workingDirectory: TEST_DIR,
        });
        expect(result.isError, result.content[0].text).toBeUndefined();
        expect(result.content[0].text).toContain('Paused named autopilot workflow');
        expect(result.content[0].text).not.toContain(state.prompt);
        expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual({ ...state, active: false });
        writeFileSync(statePath, JSON.stringify(state));
        const beforeRejectedPause = readFileSync(statePath);
        const staleDigest = await stateWriteTool.handler({
          mode: 'autopilot',
          active: false,
          state: { workflowRunId: state.workflowRunId, target_state_sha256: '0'.repeat(64) },
          session_id: sessionId,
          workingDirectory: TEST_DIR,
        });
        expect(staleDigest.isError).toBe(true);
        expect(readFileSync(statePath)).toEqual(beforeRejectedPause);
        const forgedMarkerWrite = await stateWriteTool.handler({
          mode: 'autopilot',
          active: false,
          state: { workflowRunId: '22222222-2222-4222-8222-222222222222' },
          session_id: sessionId,
          workingDirectory: TEST_DIR,
        });
        expect(forgedMarkerWrite.isError).toBe(true);
        expect(readFileSync(statePath)).toEqual(beforeRejectedPause);
      } finally {
        if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
        rmSync(configDir, { recursive: true, force: true });
      }
    });
  });

    it('rejects an incomplete named state without flock and preserves its bytes', async () => {
      const sessionId = 'named-write-no-flock';
      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');
      mkdirSync(dirname(statePath), { recursive: true });
      const state = { active: true, session_id: sessionId, workflowRunId: '11111111-1111-4111-8111-111111111111', workflow: { profileHash: 'a'.repeat(64) } };
      writeFileSync(statePath, JSON.stringify(state));
      const before = readFileSync(statePath);
      process.env.OMC_TEST_FLOCK_AVAILABLE = '0';

      const result = await stateWriteTool.handler({ mode: 'autopilot', active: false, session_id: sessionId, state: { workflowRunId: state.workflowRunId }, workingDirectory: TEST_DIR });
      expect(result.isError).toBe(true);
      expect(readFileSync(statePath)).toEqual(before);
    });

  describe('state_clear', () => {
    it.each([['supported', '1'], ['no-flock', '0']])('clears an exact malformed marker-bearing snapshot under %s runtime', async (_runtime, flock) => {
      const sessionId = `named-clear-${flock}`;
      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');
      const signalPath = join(dirname(statePath), 'cancel-signal-state.json');
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify({ active: true, session_id: sessionId, workflow: false, private: 'do-not-project' }));
      process.env.OMC_TEST_FLOCK_AVAILABLE = flock;

      const result = await stateClearTool.handler({ mode: 'autopilot', session_id: sessionId, workingDirectory: TEST_DIR });
      expect(result.isError, JSON.stringify(result)).toBeUndefined();
      expect(existsSync(statePath)).toBe(false);
      expect(existsSync(signalPath)).toBe(false);
    });

    it.each([['supported', '1'], ['no-flock', '0']])('preserves a replacement that races an exact malformed-marker clear under %s runtime', async (_runtime, flock) => {
      const sessionId = `named-clear-race-${flock}`;
      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');
      const replacement = { active: true, session_id: sessionId, replacement: true };
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify({ active: true, session_id: sessionId, workflow: false }));
      process.env.OMC_TEST_FLOCK_AVAILABLE = flock;
      if (flock === '0') {
        process.env.OMC_TEST_EMERGENCY_REPLACEMENT_PATH = statePath;
        process.env.OMC_TEST_EMERGENCY_REPLACEMENT_BASE64 = Buffer.from(JSON.stringify(replacement)).toString('base64');
      } else {
        process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_PATH = statePath;
        process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_BASE64 = Buffer.from(JSON.stringify(replacement)).toString('base64');
      }

      const result = await stateClearTool.handler({ mode: 'autopilot', session_id: sessionId, workingDirectory: TEST_DIR });
      expect(result.isError).toBe(true);
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual(replacement);
    });

    it('clears malformed named and legacy candidates during a broad clear', async () => {
      const namedPath = join(TEST_DIR, '.omc', 'state', 'sessions', 'mixed-named', 'autopilot-state.json');
      const legacyPath = join(TEST_DIR, '.omc', 'state', 'sessions', 'mixed-legacy', 'autopilot-state.json');
      mkdirSync(dirname(namedPath), { recursive: true });
      mkdirSync(dirname(legacyPath), { recursive: true });
      writeFileSync(namedPath, JSON.stringify({ active: true, session_id: 'mixed-named', workflowRunId: '77777777-7777-4777-8777-777777777777', workflow: { profileHash: 'e'.repeat(64) } }));
      writeFileSync(legacyPath, JSON.stringify({ active: true, session_id: 'mixed-legacy' }));
      process.env.OMC_TEST_FLOCK_AVAILABLE = '0';

      const result = await stateClearTool.handler({ mode: 'autopilot', workingDirectory: TEST_DIR });
      expect(result.isError, JSON.stringify(result)).toBeUndefined();
      expect(existsSync(namedPath)).toBe(false);
      expect(existsSync(legacyPath)).toBe(false);
    });

    it('clears active, paused, and terminal malformed named markers without signals', async () => {
      const sessionId = 'named-own-marker-clear';
      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');
      const signalPath = join(dirname(statePath), 'cancel-signal-state.json');
      mkdirSync(dirname(statePath), { recursive: true });
      const markerStates = [{ workflow: false }, { workflowRunId: '' }, { pipelineTracking: null }];

      for (const status of [{ active: true }, { active: false }, { active: false, phase: 'complete' }]) {
        for (const marker of markerStates) {
          rmSync(signalPath, { force: true });
          writeFileSync(statePath, JSON.stringify({ ...status, session_id: sessionId, ...marker }));
          const result = await stateClearTool.handler({ mode: 'autopilot', session_id: sessionId, workingDirectory: TEST_DIR });
          expect(result.isError, JSON.stringify(result)).toBeUndefined();
          expect(existsSync(statePath)).toBe(false);
          expect(existsSync(signalPath)).toBe(false);
        }
      }
    });

    it('clears recovered malformed named primaries during session cleanup', async () => {
      const sessionId = 'multi-named-owner';
      const canonical = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');
      const stranded = join(TEST_DIR, '.omc', 'state', 'sessions', 'stale-dir', 'autopilot-state.json');
      const state = { active: true, session_id: sessionId, workflowRunId: '11111111-1111-4111-8111-111111111111', workflow: { profileHash: 'a'.repeat(64) } };
      mkdirSync(dirname(canonical), { recursive: true });
      mkdirSync(dirname(stranded), { recursive: true });
      writeFileSync(canonical, JSON.stringify(state));
      writeFileSync(stranded, JSON.stringify({ ...state, workflowRunId: '22222222-2222-4222-8222-222222222222' }));
      process.env.OMC_TEST_FLOCK_AVAILABLE = '0';

      const result = await stateClearTool.handler({ mode: 'autopilot', session_id: sessionId, workingDirectory: TEST_DIR });
      expect(result.isError, JSON.stringify(result)).toBeUndefined();
      expect(existsSync(canonical)).toBe(false);
      expect(existsSync(stranded)).toBe(false);
    });

    it('clears an incomplete named state without starting a portable pause transaction', async () => {
      const sessionId = 'interrupted-pause-clear';
      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');
      mkdirSync(dirname(statePath), { recursive: true });
      const state = { active: true, session_id: sessionId, workflowRunId: '11111111-1111-4111-8111-111111111111', workflow: { profileHash: 'a'.repeat(64) } };
      writeFileSync(statePath, JSON.stringify(state));
      process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
      process.env.OMC_TEST_EMERGENCY_CRASH_PHASE = 'after-rename';
      expect((await stateWriteTool.handler({ mode: 'autopilot', active: false, session_id: sessionId, state: { workflowRunId: state.workflowRunId }, workingDirectory: TEST_DIR })).isError).toBe(true);
      delete process.env.OMC_TEST_EMERGENCY_CRASH_PHASE;
      expect(existsSync(`${statePath}.emergency-journal.json`)).toBe(false);

      const result = await stateClearTool.handler({ mode: 'autopilot', session_id: sessionId, workingDirectory: TEST_DIR });
      expect(result.isError, JSON.stringify(result)).toBeUndefined();
      expect(existsSync(statePath)).toBe(false);
    });

    it('does not recover or reject another session emergency transaction', async () => {
      const ownPath = join(TEST_DIR, '.omc', 'state', 'sessions', 'recovery-owner-a', 'autopilot-state.json');
      const otherPath = join(TEST_DIR, '.omc', 'state', 'sessions', 'recovery-owner-b', 'autopilot-state.json');
      for (const [path, owner, run] of [[ownPath, 'recovery-owner-a', '44444444-4444-4444-8444-444444444444'], [otherPath, 'recovery-owner-b', '55555555-5555-4555-8555-555555555555']] as const) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({ active: true, session_id: owner, workflowRunId: run, workflow: { profileHash: 'c'.repeat(64) } }));
      }
      process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
      process.env.OMC_TEST_EMERGENCY_CRASH_PHASE = 'after-rename';
      expect(emergencyMutateStateFileIf(otherPath, (state) => state.session_id === 'recovery-owner-b', (state) => ({ ...state, active: false }))).toBe(false);
      delete process.env.OMC_TEST_EMERGENCY_CRASH_PHASE;
      expect(existsSync(`${otherPath}.emergency-journal.json`)).toBe(true);

      const result = await stateClearTool.handler({ mode: 'autopilot', session_id: 'recovery-owner-a', workingDirectory: TEST_DIR });
      expect(result.isError, JSON.stringify(result)).toBeUndefined();
      expect(existsSync(ownPath)).toBe(false);
      expect(existsSync(`${otherPath}.emergency-journal.json`)).toBe(true);
    });

    it('signals and clears the home-global autopilot fallback during broad clear', async () => {
      const previousHome = process.env.HOME;
      const home = join(TEST_DIR, 'home-global');
      process.env.HOME = home;
      try {
        const statePath = join(home, '.omc', 'state', 'autopilot-state.json');
        mkdirSync(dirname(statePath), { recursive: true });
        const state = { active: true, project_path: TEST_DIR };
        writeFileSync(statePath, JSON.stringify(state));

        const result = await stateClearTool.handler({ mode: 'autopilot', workingDirectory: TEST_DIR });
        expect(result.isError).toBeUndefined();
        expect(existsSync(statePath)).toBe(false);
        const signal = JSON.parse(readFileSync(join(dirname(statePath), 'cancel-signal-state.json'), 'utf8'));
        expect(signal.target_workflow_run_id).toBeUndefined();
        expect(signal.target_state_sha256).toMatch(/^[a-f0-9]{64}$/);
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      }
    });
    it('recovers a same-project shared-session clear transaction with no primary during broad clear', async () => {
      const previousHome = process.env.HOME;
      const home = join(TEST_DIR, 'home-shared-session-clear-intent');
      process.env.HOME = home;
      try {
        const statePath = join(home, '.omc', 'state', 'sessions', 'project-a-clear', 'autopilot-state.json');
        mkdirSync(dirname(statePath), { recursive: true });
        writeFileSync(statePath, JSON.stringify({ active: true, project_path: TEST_DIR, workflowRunId: 'acacacac-acac-4cac-8cac-acacacacacac', workflow: { profileHash: 'a'.repeat(64) } }));
        process.env.OMC_TEST_EMERGENCY_CRASH_PHASE = 'after-rename';
        expect(emergencyMutateStateFileIf(statePath, (state) => state.project_path === TEST_DIR, null)).toBe(false);
        delete process.env.OMC_TEST_EMERGENCY_CRASH_PHASE;
        expect(existsSync(statePath)).toBe(false);
        expect(existsSync(`${statePath}.emergency-journal.json`)).toBe(true);

        const result = await stateClearTool.handler({ mode: 'autopilot', workingDirectory: TEST_DIR });
        expect(result.isError, JSON.stringify(result)).toBeUndefined();
        expect(existsSync(statePath)).toBe(false);
        expect(existsSync(`${statePath}.emergency-journal.json`)).toBe(false);
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      }
    });
    it('preserves a foreign dead publication temp beside an authorized home-global state', async () => {
      const previousHome = process.env.HOME;
      const home = join(TEST_DIR, 'home-global-foreign-temp');
      process.env.HOME = home;
      try {
        const statePath = join(home, '.omc', 'state', 'autopilot-state.json');
        const foreignTemp = `${statePath}.emergency-quarantine.${randomUUID()}.payload.999999999.1.${randomUUID()}.tmp`;
        const primary = JSON.stringify({ active: true, project_path: TEST_DIR, workflowRunId: 'adadadad-adad-4dad-8dad-adadadadadad' });
        mkdirSync(dirname(statePath), { recursive: true });
        writeFileSync(statePath, primary);
        writeFileSync(foreignTemp, JSON.stringify({ active: false, project_path: join(TEST_DIR, 'other-project') }));

        const result = await stateClearTool.handler({ mode: 'autopilot', workingDirectory: TEST_DIR });
        expect(result.isError).toBe(true);
        expect(readFileSync(statePath, 'utf8')).toBe(primary);
        expect(existsSync(foreignTemp)).toBe(true);
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      }
    });

    it('preserves a malformed journal beside an authorized shared-session state', async () => {
      const previousHome = process.env.HOME;
      const home = join(TEST_DIR, 'home-shared-session-malformed-journal');
      process.env.HOME = home;
      try {
        const statePath = join(home, '.omc', 'state', 'sessions', 'project-a', 'autopilot-state.json');
        const journalPath = `${statePath}.emergency-journal.json`;
        const primary = JSON.stringify({ active: true, project_path: TEST_DIR, workflowRunId: 'aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeae' });
        mkdirSync(dirname(statePath), { recursive: true });
        writeFileSync(statePath, primary);
        writeFileSync(journalPath, '{"version":1');

        const result = await stateClearTool.handler({ mode: 'autopilot', workingDirectory: TEST_DIR });
        expect(result.isError).toBe(true);
        expect(readFileSync(statePath, 'utf8')).toBe(primary);
        expect(readFileSync(journalPath, 'utf8')).toBe('{"version":1');
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      }
    });


    it('preserves an unrelated-project home-global autopilot fallback without signaling', async () => {
      const previousHome = process.env.HOME;
      const home = join(TEST_DIR, 'home-unrelated');
      process.env.HOME = home;
      try {
        const statePath = join(home, '.omc', 'state', 'autopilot-state.json');
        mkdirSync(dirname(statePath), { recursive: true });
        const raw = JSON.stringify({ active: true, project_path: join(TEST_DIR, 'other-project'), workflowRunId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
        writeFileSync(statePath, raw);

        const result = await stateClearTool.handler({ mode: 'autopilot', workingDirectory: TEST_DIR });
        expect(result.isError).toBeUndefined();
        expect(readFileSync(statePath, 'utf8')).toBe(raw);
        expect(existsSync(join(dirname(statePath), 'cancel-signal-state.json'))).toBe(false);
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      }
    });
    it('preserves unrelated shared-session autopilot state and emergency artifacts during broad clear', async () => {
      const previousHome = process.env.HOME;
      const home = join(TEST_DIR, 'home-shared-session-projects');
      process.env.HOME = home;
      try {
        const projectAPath = join(home, '.omc', 'state', 'sessions', 'project-a-named', 'autopilot-state.json');
        const projectALegacyPath = join(home, '.omc', 'state', 'sessions', 'project-a-legacy', 'autopilot-state.json');
        const projectBPath = join(home, '.omc', 'state', 'sessions', 'project-b-named', 'autopilot-state.json');
        const projectBRecoveryPath = join(home, '.omc', 'state', 'sessions', 'project-b-recovery', 'autopilot-state.json');
        const projectBLegacyPath = join(home, '.omc', 'state', 'sessions', 'project-b-legacy', 'autopilot-state.json');
        const otherProject = join(TEST_DIR, 'other-project');
        for (const path of [projectAPath, projectALegacyPath, projectBPath, projectBRecoveryPath, projectBLegacyPath]) {
          mkdirSync(dirname(path), { recursive: true });
        }
        writeFileSync(projectAPath, JSON.stringify({ active: true, project_path: TEST_DIR, workflowRunId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', workflow: { profileHash: 'a'.repeat(64) } }));
        writeFileSync(projectALegacyPath, JSON.stringify({ active: true, project_path: TEST_DIR }));
        writeFileSync(projectBPath, JSON.stringify({ active: true, project_path: otherProject, workflowRunId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', workflow: { profileHash: 'b'.repeat(64) } }));
        writeFileSync(projectBRecoveryPath, JSON.stringify({ active: true, project_path: otherProject, workflowRunId: 'bdbdbdbd-bdbd-4dbd-8dbd-bdbdbdbdbdbd', workflow: { profileHash: 'd'.repeat(64) } }));
        writeFileSync(projectBLegacyPath, JSON.stringify({ active: true, project_path: otherProject, workflowRunId: 'bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc' }));
        process.env.OMC_TEST_FLOCK_AVAILABLE = '0';

        process.env.OMC_TEST_EMERGENCY_CRASH_PHASE = 'after-publication';
        expect(emergencyMutateStateFileIf(projectBPath, (state) => state.project_path === otherProject, (state) => ({ ...state, active: false }))).toBe(false);
        delete process.env.OMC_TEST_EMERGENCY_CRASH_PHASE;
        const projectBBefore = readFileSync(projectBPath);
        const projectBArtifacts = new Map(readdirSync(dirname(projectBPath))
          .filter((name) => name.startsWith(`${basename(projectBPath)}.emergency-`))
          .map((name) => [name, readFileSync(join(dirname(projectBPath), name))]));
        expect(projectBArtifacts.size).toBeGreaterThan(0);

        process.env.OMC_TEST_EMERGENCY_CRASH_PHASE = 'after-rename';
        expect(emergencyMutateStateFileIf(projectBRecoveryPath, (state) => state.project_path === otherProject, null)).toBe(false);
        delete process.env.OMC_TEST_EMERGENCY_CRASH_PHASE;
        expect(existsSync(projectBRecoveryPath)).toBe(false);
        const projectBRecoveryArtifacts = new Map(readdirSync(dirname(projectBRecoveryPath))
          .filter((name) => name.startsWith(`${basename(projectBRecoveryPath)}.emergency-`))
          .map((name) => [name, readFileSync(join(dirname(projectBRecoveryPath), name))]));
        expect(projectBRecoveryArtifacts.size).toBeGreaterThan(0);
        const projectBLegacyBefore = readFileSync(projectBLegacyPath);

        const result = await stateClearTool.handler({ mode: 'autopilot', workingDirectory: TEST_DIR });

        expect(result.isError, JSON.stringify(result)).toBeUndefined();
        expect(existsSync(projectAPath)).toBe(false);
        expect(existsSync(projectALegacyPath)).toBe(false);
        expect(readFileSync(projectBPath)).toEqual(projectBBefore);
        expect(existsSync(projectBRecoveryPath)).toBe(false);
        expect(readFileSync(projectBLegacyPath)).toEqual(projectBLegacyBefore);
        expect(existsSync(join(dirname(projectBPath), 'cancel-signal-state.json'))).toBe(false);
        expect(existsSync(join(dirname(projectBRecoveryPath), 'cancel-signal-state.json'))).toBe(false);
        expect(existsSync(join(dirname(projectBLegacyPath), 'cancel-signal-state.json'))).toBe(false);
        for (const [name, contents] of projectBArtifacts) {
          expect(readFileSync(join(dirname(projectBPath), name))).toEqual(contents);
        }
        for (const [name, contents] of projectBRecoveryArtifacts) {
          expect(readFileSync(join(dirname(projectBRecoveryPath), name))).toEqual(contents);
        }
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      }
    });

    it('recovers interrupted canonical and legacy named pauses before broad clear', async () => {
      const canonical = join(TEST_DIR, '.omc', 'state', 'sessions', 'broad-journal-owner', 'autopilot-state.json');
      const legacy = join(TEST_DIR, '.omc', 'state', 'autopilot-state.json');
      for (const [path, run] of [[canonical, '22222222-2222-4222-8222-222222222222'], [legacy, '33333333-3333-4333-8333-333333333333']] as const) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({ active: true, session_id: 'broad-journal-owner', workflowRunId: run, workflow: { profileHash: 'b'.repeat(64) } }));
      process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
        process.env.OMC_TEST_EMERGENCY_CRASH_PHASE = 'after-rename';
        expect(emergencyMutateStateFileIf(path, (state) => state.workflowRunId === run, (state) => ({ ...state, active: false }))).toBe(false);
        delete process.env.OMC_TEST_EMERGENCY_CRASH_PHASE;
        expect(existsSync(`${path}.emergency-journal.json`)).toBe(true);
      }

      const result = await stateClearTool.handler({ mode: 'autopilot', workingDirectory: TEST_DIR });
      expect(result.isError, JSON.stringify(result)).toBeUndefined();
      expect(existsSync(canonical)).toBe(false);
      expect(existsSync(legacy)).toBe(false);
    });
    it('recovers an interrupted named transaction from the centralized root before broad clear', async () => {
      const previous = process.env.OMC_STATE_DIR;
      process.env.OMC_STATE_DIR = join(TEST_DIR, 'central-emergency-root');
      try {
        const { getOmcRoot } = await import('../../lib/worktree-paths.js');
        const statePath = join(getOmcRoot(TEST_DIR), 'state', 'sessions', 'central-journal-owner', 'autopilot-state.json');
        mkdirSync(dirname(statePath), { recursive: true });
        writeFileSync(statePath, JSON.stringify({ active: true, session_id: 'central-journal-owner', workflowRunId: '66666666-6666-4666-8666-666666666666', workflow: { profileHash: 'd'.repeat(64) } }));
        process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
        process.env.OMC_TEST_EMERGENCY_CRASH_PHASE = 'after-rename';
        expect(emergencyMutateStateFileIf(statePath, (state) => state.session_id === 'central-journal-owner', (state) => ({ ...state, active: false }))).toBe(false);
        delete process.env.OMC_TEST_EMERGENCY_CRASH_PHASE;

        const result = await stateClearTool.handler({ mode: 'autopilot', workingDirectory: TEST_DIR });
        expect(result.isError, JSON.stringify(result)).toBeUndefined();
        expect(existsSync(statePath)).toBe(false);
      } finally {
        if (previous === undefined) delete process.env.OMC_STATE_DIR;
        else process.env.OMC_STATE_DIR = previous;
      }
    });

    it('should remove legacy state file when no session_id provided', async () => {
      await stateWriteTool.handler({
        mode: 'ralph',
        state: { active: true },
        workingDirectory: TEST_DIR,
      });

      const legacyPath = join(TEST_DIR, '.omc', 'state', 'ralph-state.json');
      expect(existsSync(legacyPath)).toBe(true);

      const result = await stateClearTool.handler({
        mode: 'ralph',
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toMatch(/cleared|Successfully/i);
      expect(existsSync(legacyPath)).toBe(false);
    });

    it('should clear ralplan state with explicit session_id', async () => {
      const sessionId = 'test-session-ralplan';
      const sessionDir = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, 'ralplan-state.json'),
        JSON.stringify({ active: true })
      );

      const result = await stateClearTool.handler({
        mode: 'ralplan',
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('cleared');
      expect(existsSync(join(sessionDir, 'ralplan-state.json'))).toBe(false);
    });

    it('should also remove non-session legacy state files during session clear', async () => {
      const sessionId = 'legacy-cleanup-session';
      const sessionDir = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, 'ralph-state.json'),
        JSON.stringify({ active: true, session_id: sessionId }),
      );

      const legacyRootPath = join(TEST_DIR, '.omc', 'ralph-state.json');
      writeFileSync(
        legacyRootPath,
        JSON.stringify({ active: true, session_id: sessionId }),
      );

      const result = await stateClearTool.handler({
        mode: 'ralph',
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('ghost legacy file also removed');
      expect(existsSync(join(sessionDir, 'ralph-state.json'))).toBe(false);
      expect(existsSync(legacyRootPath)).toBe(false);
    });

    it('should clear only the requested session for every execution mode', async () => {
      const modes = ['autopilot', 'autoresearch', 'ralph', 'ultrawork', 'ultraqa', 'team'] as const;
      const sessionA = 'session-a';
      const sessionB = 'session-b';

      for (const mode of modes) {
        await stateWriteTool.handler({
          mode,
          state: { active: true, owner: 'A' },
          session_id: sessionA,
          workingDirectory: TEST_DIR,
        });
        await stateWriteTool.handler({
          mode,
          state: { active: true, owner: 'B' },
          session_id: sessionB,
          workingDirectory: TEST_DIR,
        });

        const clearResult = await stateClearTool.handler({
          mode,
          session_id: sessionA,
          workingDirectory: TEST_DIR,
        });

        expect(clearResult.content[0].text).toMatch(/cleared|Successfully/i);

        const sessionAPath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionA, `${mode}-state.json`);
        const sessionBPath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionB, `${mode}-state.json`);

        expect(existsSync(sessionAPath)).toBe(false);
        expect(existsSync(sessionBPath)).toBe(true);
      }
    });

    it('should clear legacy and all sessions when session_id is omitted and show warning', async () => {
      const sessionId = 'aggregate-clear';
      await stateWriteTool.handler({
        mode: 'ultrawork',
        state: { active: true, source: 'legacy' },
        workingDirectory: TEST_DIR,
      });
      await stateWriteTool.handler({
        mode: 'ultrawork',
        state: { active: true, source: 'session' },
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      const result = await stateClearTool.handler({
        mode: 'ultrawork',
        workingDirectory: TEST_DIR,
      });

      const legacyPath = join(TEST_DIR, '.omc', 'state', 'ultrawork-state.json');
      const sessionPath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'ultrawork-state.json');

      expect(result.content[0].text).toContain('WARNING: No session_id provided');
      expect(existsSync(legacyPath)).toBe(false);
      expect(existsSync(sessionPath)).toBe(false);
    });

    it('lists and clears active legacy global ralph state without touching unrelated state', async () => {
      const homeRoot = mkdtempSync(join(tmpdir(), 'state-tools-home-'));
      vi.stubEnv('HOME', homeRoot);
      vi.stubEnv('USERPROFILE', homeRoot);
      try {
        const legacyGlobalStateDir = join(homeRoot, '.omc', 'state');
        mkdirSync(legacyGlobalStateDir, { recursive: true });
        const ralphPath = join(legacyGlobalStateDir, 'ralph-state.json');
        const unrelatedPath = join(legacyGlobalStateDir, 'ultrawork-state.json');
        writeFileSync(ralphPath, JSON.stringify({ active: true, legacy: true }));
        writeFileSync(unrelatedPath, JSON.stringify({ active: true, unrelated: true }));

        const listResult = await stateListActiveTool.handler({
          all: true,
          workingDirectory: TEST_DIR,
        });
        expect(listResult.content[0].text).toContain('ralph');

        const clearResult = await stateClearTool.handler({
          mode: 'ralph',
          workingDirectory: TEST_DIR,
        });
        expect(clearResult.content[0].text).toMatch(/Cleared|Successfully/i);
        expect(existsSync(ralphPath)).toBe(false);
        expect(existsSync(unrelatedPath)).toBe(true);
      } finally {
        vi.unstubAllEnvs();
        rmSync(homeRoot, { recursive: true, force: true });
      }
    });

    it('lists and clears worktree-local session ralph state with session cwd context only', async () => {
      const centralizedRoot = mkdtempSync(join(tmpdir(), 'state-tools-central-'));
      vi.stubEnv('OMC_STATE_DIR', centralizedRoot);
      try {
        const sessionId = 'local-ralph-session';
        const unrelatedSessionId = 'unrelated-session';
        const sessionDir = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId);
        const unrelatedSessionDir = join(TEST_DIR, '.omc', 'state', 'sessions', unrelatedSessionId);
        mkdirSync(sessionDir, { recursive: true });
        mkdirSync(unrelatedSessionDir, { recursive: true });
        const localRalphPath = join(sessionDir, 'ralph-state.json');
        const unrelatedRalphPath = join(unrelatedSessionDir, 'ralph-state.json');
        writeFileSync(localRalphPath, JSON.stringify({ active: true, session_id: sessionId }));
        writeFileSync(unrelatedRalphPath, JSON.stringify({ active: true, session_id: unrelatedSessionId }));

        const listResult = await stateListActiveTool.handler({
          session_id: sessionId,
          workingDirectory: TEST_DIR,
        });
        expect(listResult.content[0].text).toContain('ralph');

        const clearResult = await stateClearTool.handler({
          mode: 'ralph',
          session_id: sessionId,
          workingDirectory: TEST_DIR,
        });
        expect(clearResult.content[0].text).toContain('cleared');
        expect(existsSync(localRalphPath)).toBe(false);
        expect(existsSync(unrelatedRalphPath)).toBe(true);
      } finally {
        vi.unstubAllEnvs();
        rmSync(centralizedRoot, { recursive: true, force: true });
      }
    });

    it('should not report false errors for sessions with no state file during broad clear', async () => {
      // Create a session directory but no state file for ralph mode
      const sessionId = 'empty-session';
      const sessionDir = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      // Note: no state file created - simulating a session with no ralph state

      // Create state for a different mode in the same session
      await stateWriteTool.handler({
        mode: 'ultrawork',
        state: { active: true },
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      // Now clear ralph mode (which has no state in this session)
      const result = await stateClearTool.handler({
        mode: 'ralph',
        workingDirectory: TEST_DIR,
      });

      // Should report "No state found" not errors
      expect(result.content[0].text).toContain('No state found');
      expect(result.content[0].text).not.toContain('Errors:');
    });

    it('should only count actual deletions in broad clear count', async () => {
      // Create state in only one session out of multiple
      const sessionWithState = 'has-state';
      const sessionWithoutState = 'no-state';

      // Create session directories
      mkdirSync(join(TEST_DIR, '.omc', 'state', 'sessions', sessionWithState), { recursive: true });
      mkdirSync(join(TEST_DIR, '.omc', 'state', 'sessions', sessionWithoutState), { recursive: true });

      // Only create state for one session
      await stateWriteTool.handler({
        mode: 'ralph',
        state: { active: true },
        session_id: sessionWithState,
        workingDirectory: TEST_DIR,
      });

      const result = await stateClearTool.handler({
        mode: 'ralph',
        workingDirectory: TEST_DIR,
      });

      // Should report exactly 1 location cleared (the session with state)
      expect(result.content[0].text).toContain('Locations cleared: 1');
      expect(result.content[0].text).not.toContain('Errors:');
    });

    it('does not count a broad-clear replacement run as deleted', async () => {
      await stateWriteTool.handler({ mode: 'autopilot', active: true, workingDirectory: TEST_DIR });
      const statePath = join(TEST_DIR, '.omc', 'state', 'autopilot-state.json');
      const replacement = { active: true };
      process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_PATH = statePath;
      process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_BASE64 = Buffer.from(JSON.stringify(replacement)).toString('base64');

      const result = await stateClearTool.handler({ mode: 'autopilot', workingDirectory: TEST_DIR });
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual(replacement);
      expect(result.content[0].text).not.toContain('Locations cleared: 1');
      expect(result.content[0].text).toContain('skipped');
      expect(result.isError).toBe(true);
    });

    it('clears a stranded recovered workflow by its captured path in broad mode', async () => {
      const strandedPath = join(TEST_DIR, '.omc', 'state', 'sessions', 'stale-dir', 'autopilot-state.json');
      mkdirSync(dirname(strandedPath), { recursive: true });
      writeFileSync(strandedPath, JSON.stringify({ active: true, session_id: 'owner-session' }));

      const result = await stateClearTool.handler({ mode: 'autopilot', workingDirectory: TEST_DIR });
      expect(existsSync(strandedPath)).toBe(false);
      expect(result.content[0].text).toContain('Locations cleared: 1');
      expect(result.isError).not.toBe(true);
      const signalPath = join(TEST_DIR, '.omc', 'state', 'sessions', 'owner-session', 'cancel-signal-state.json');
      expect(JSON.parse(readFileSync(signalPath, 'utf8')).target_workflow_run_id).toBeUndefined();
    });

    it('reports a broad converged-path replacement as incomplete', async () => {
      const sessionId = 'converged-replacement';
      await stateWriteTool.handler({ mode: 'ralph', active: true, session_id: sessionId, workingDirectory: TEST_DIR });
      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'ralph-state.json');
      const replacement = { active: true, session_id: sessionId, workflowRunId: 'replacement-run' };
      process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_PATH = statePath;
      process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_BASE64 = Buffer.from(JSON.stringify(replacement)).toString('base64');

      const result = await stateClearTool.handler({ mode: 'ralph', workingDirectory: TEST_DIR });
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual(replacement);
      expect(result.content[0].text).not.toContain('Locations cleared: 1');
      expect(result.content[0].text).toContain('survived');
      expect(result.isError).toBe(true);
    });

    it('should clear skill-active state with session_id (fix for #2118)', async () => {
      const sessionId = 'test-skill-active-clear';

      await stateWriteTool.handler({
        mode: 'skill-active',
        active: true,
        state: { skill_name: 'sciomc', reinforcement_count: 2 },
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      // Verify skill-active appears in the active list before clearing
      const listBefore = await stateListActiveTool.handler({
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });
      expect(listBefore.content[0].text).toContain('skill-active');

      const clearResult = await stateClearTool.handler({
        mode: 'skill-active',
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(clearResult.content[0].text).toContain('cleared');

      const readResult = await stateReadTool.handler({
        mode: 'skill-active',
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });
      // stateReadTool returning "No state found" is authoritative proof the file is gone
      expect(readResult.content[0].text).toContain('No state found');
    });

    it('clears completed-session orphan state when cancel runs from a fresh session id', async () => {
      const freshSessionId = 'fresh-cancel-session';
      const liveSessionId = 'live-sibling-session';
      const orphanSessionIds = ['ended-session-one', 'ended-session-two'];
      const modes = ['ralph', 'ultrawork', 'team'] as const;

      mkdirSync(join(TEST_DIR, '.omc', 'sessions'), { recursive: true });

      for (const orphanSessionId of orphanSessionIds) {
        mkdirSync(join(TEST_DIR, '.omc', 'state', 'sessions', orphanSessionId), { recursive: true });
        writeFileSync(
          join(TEST_DIR, '.omc', 'sessions', `${orphanSessionId}.json`),
          JSON.stringify({ session_id: orphanSessionId, ended_at: '2026-05-04T00:00:00.000Z' }),
        );
      }
      mkdirSync(join(TEST_DIR, '.omc', 'state', 'sessions', liveSessionId), { recursive: true });

      for (const mode of modes) {
        for (const orphanSessionId of orphanSessionIds) {
          writeFileSync(
            join(TEST_DIR, '.omc', 'state', 'sessions', orphanSessionId, `${mode}-state.json`),
            JSON.stringify({
              active: true,
              session_id: orphanSessionId,
              ...(mode === 'team' ? { team_name: `team-${orphanSessionId}` } : {}),
            }),
          );
        }
        writeFileSync(
          join(TEST_DIR, '.omc', 'state', 'sessions', liveSessionId, `${mode}-state.json`),
          JSON.stringify({ active: true, session_id: liveSessionId }),
        );

        const result = await stateClearTool.handler({
          mode,
          session_id: freshSessionId,
          workingDirectory: TEST_DIR,
        });

        expect(result.content[0].text).toContain('completed-session orphan');
        for (const orphanSessionId of orphanSessionIds) {
          expect(existsSync(join(TEST_DIR, '.omc', 'state', 'sessions', orphanSessionId, `${mode}-state.json`))).toBe(false);
        }
        expect(existsSync(join(TEST_DIR, '.omc', 'state', 'sessions', liveSessionId, `${mode}-state.json`))).toBe(true);
      }
    });

    it('preserves a replacement run at a completed-session candidate path', async () => {
      const requester = 'fresh-cancel';
      const endedSession = 'ended-replaced-session';
      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', endedSession, 'ultrawork-state.json');
      mkdirSync(dirname(statePath), { recursive: true });
      mkdirSync(join(TEST_DIR, '.omc', 'sessions'), { recursive: true });
      writeFileSync(join(TEST_DIR, '.omc', 'sessions', `${endedSession}.json`), JSON.stringify({ session_id: endedSession, ended_at: '2026-05-04T00:00:00.000Z' }));
      writeFileSync(statePath, JSON.stringify({ active: true, session_id: endedSession, workflowRunId: 'old-run' }));
      const replacement = { active: true, session_id: endedSession, workflowRunId: 'replacement-run' };
      process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_PATH = statePath;
      process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_BASE64 = Buffer.from(JSON.stringify(replacement)).toString('base64');

      await stateClearTool.handler({ mode: 'ultrawork', session_id: requester, workingDirectory: TEST_DIR });
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual(replacement);
    });

    it('reports completed-session orphan state on session-scoped read misses', async () => {
      const freshSessionId = 'fresh-read-session';
      const orphanSessionId = 'ended-read-session';
      mkdirSync(join(TEST_DIR, '.omc', 'sessions'), { recursive: true });
      mkdirSync(join(TEST_DIR, '.omc', 'state', 'sessions', orphanSessionId), { recursive: true });
      writeFileSync(
        join(TEST_DIR, '.omc', 'sessions', `${orphanSessionId}.json`),
        JSON.stringify({ session_id: orphanSessionId, ended_at: '2026-05-04T00:00:00.000Z' }),
      );
      writeFileSync(
        join(TEST_DIR, '.omc', 'state', 'sessions', orphanSessionId, 'ralph-state.json'),
        JSON.stringify({ active: true, session_id: orphanSessionId }),
      );

      const result = await stateReadTool.handler({
        mode: 'ralph',
        session_id: freshSessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('completed-session orphan');
      expect(result.content[0].text).toContain(orphanSessionId);
    });

    it('clears completed-session orphan state through a symlinked .omc directory', async () => {
      const symlinkTestDir = mkdtempSync(join(tmpdir(), 'state-tools-symlink-'));
      const realOmcDir = mkdtempSync(join(tmpdir(), 'state-tools-real-omc-'));
      try {
        rmSync(join(symlinkTestDir, '.omc'), { recursive: true, force: true });
        symlinkSync(realOmcDir, join(symlinkTestDir, '.omc'), 'dir');
        const orphanSessionId = 'ended-symlink-session';
        const freshSessionId = 'fresh-symlink-session';
        mkdirSync(join(realOmcDir, 'sessions'), { recursive: true });
        mkdirSync(join(realOmcDir, 'state', 'sessions', orphanSessionId), { recursive: true });
        writeFileSync(
          join(realOmcDir, 'sessions', `${orphanSessionId}.json`),
          JSON.stringify({ session_id: orphanSessionId, ended_at: '2026-05-04T00:00:00.000Z' }),
        );
        writeFileSync(
          join(realOmcDir, 'state', 'sessions', orphanSessionId, 'ultrawork-state.json'),
          JSON.stringify({ active: true, session_id: orphanSessionId }),
        );

        const result = await stateClearTool.handler({
          mode: 'ultrawork',
          session_id: freshSessionId,
          workingDirectory: symlinkTestDir,
        });

        expect(result.content[0].text).toContain('completed-session orphan');
        expect(existsSync(join(realOmcDir, 'state', 'sessions', orphanSessionId, 'ultrawork-state.json'))).toBe(false);
      } finally {
        rmSync(symlinkTestDir, { recursive: true, force: true });
        rmSync(realOmcDir, { recursive: true, force: true });
      }
    });

    it('should list skill-active as active when state file is present', async () => {
      const sessionId = 'skill-active-list-test';

      await stateWriteTool.handler({
        mode: 'skill-active',
        active: true,
        state: { skill_name: 'learner' },
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      const result = await stateListActiveTool.handler({
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('skill-active');
    });
  });

  describe('state_list_active', () => {
    it('should list active modes in current session when session_id provided', async () => {
      const sessionId = 'active-session-test';
      await stateWriteTool.handler({
        mode: 'ralph',
        active: true,
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      const result = await stateListActiveTool.handler({
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('ralph');
    });

    it('should list active modes across sessions when session_id omitted', async () => {
      const sessionId = 'aggregate-session';
      await stateWriteTool.handler({
        mode: 'ultrawork',
        active: true,
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      const result = await stateListActiveTool.handler({
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('ultrawork');
      expect(result.content[0].text).toContain(sessionId);
    });

    it('should include team mode when team state is active', async () => {
      await stateWriteTool.handler({
        mode: 'team',
        active: true,
        state: { phase: 'team-exec' },
        workingDirectory: TEST_DIR,
      });

      const result = await stateListActiveTool.handler({
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('team');
    });

    it('should include autoresearch mode when autoresearch state is active', async () => {
      await stateWriteTool.handler({
        mode: 'autoresearch',
        active: true,
        state: { phase: 'running' },
        workingDirectory: TEST_DIR,
      });

      const result = await stateListActiveTool.handler({
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('autoresearch');
    });

    it('should include deep-interview mode when deep-interview state is active', async () => {
      await stateWriteTool.handler({
        mode: 'deep-interview',
        active: true,
        state: { phase: 'questioning' },
        workingDirectory: TEST_DIR,
      });

      const result = await stateListActiveTool.handler({
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('deep-interview');
    });

    it('should include self-improve mode when self-improve state is active', async () => {
      await stateWriteTool.handler({
        mode: 'self-improve',
        active: true,
        state: { tournament_round: 1 },
        workingDirectory: TEST_DIR,
      });

      const result = await stateListActiveTool.handler({
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('self-improve');
    });

    it('should include team in status output when team state is active', async () => {
      await stateWriteTool.handler({
        mode: 'team',
        active: true,
        state: { phase: 'team-verify' },
        workingDirectory: TEST_DIR,
      });

      const result = await stateGetStatusTool.handler({
        mode: 'team',
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('Status: team');
      expect(result.content[0].text).toContain('**Active:** Yes');
    });

    it('deep-interview and self-improve appear in all-mode status listing', async () => {
      const result = await stateGetStatusTool.handler({
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('deep-interview');
      expect(result.content[0].text).toContain('self-improve');
    });
  });

  // -----------------------------------------------------------------------
  // Registry parity: deep-interview and self-improve as first-class modes
  // -----------------------------------------------------------------------
  describe('deep-interview and self-improve registry parity (T1)', () => {
    it('writes deep-interview state to session-scoped path via MODE_CONFIGS routing', async () => {
      const sessionId = 'di-registry-write';
      await stateWriteTool.handler({
        mode: 'deep-interview',
        active: true,
        state: { current_phase: 'questioning', round: 3 },
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'deep-interview-state.json');
      expect(existsSync(statePath)).toBe(true);
    });

    it('writes self-improve state to session-scoped path via MODE_CONFIGS routing', async () => {
      const sessionId = 'si-registry-write';
      await stateWriteTool.handler({
        mode: 'self-improve',
        active: true,
        state: { tournament_round: 1, best_score: 0.85 },
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'self-improve-state.json');
      expect(existsSync(statePath)).toBe(true);
    });

    it('reads deep-interview state back from session-scoped path', async () => {
      const sessionId = 'di-registry-read';
      await stateWriteTool.handler({
        mode: 'deep-interview',
        active: true,
        state: { current_phase: 'questioning', ambiguity_score: 0.34 },
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      const result = await stateReadTool.handler({
        mode: 'deep-interview',
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('current_phase');
      expect(result.content[0].text).toContain('ambiguity_score');
    });

    it('reads self-improve state back from session-scoped path', async () => {
      const sessionId = 'si-registry-read';
      await stateWriteTool.handler({
        mode: 'self-improve',
        active: true,
        state: { tournament_round: 2, generation: 5 },
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      const result = await stateReadTool.handler({
        mode: 'self-improve',
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('tournament_round');
      expect(result.content[0].text).toContain('generation');
    });

    it('clears deep-interview state file for given session', async () => {
      const sessionId = 'di-registry-clear';
      await stateWriteTool.handler({
        mode: 'deep-interview',
        active: true,
        state: { current_phase: 'analysis' },
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      const clearResult = await stateClearTool.handler({
        mode: 'deep-interview',
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(clearResult.content[0].text).toMatch(/cleared|Successfully/i);
      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'deep-interview-state.json');
      expect(existsSync(statePath)).toBe(false);
    });

    it('clears self-improve state file for given session', async () => {
      const sessionId = 'si-registry-clear';
      await stateWriteTool.handler({
        mode: 'self-improve',
        active: true,
        state: { tournament_round: 3 },
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      const clearResult = await stateClearTool.handler({
        mode: 'self-improve',
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(clearResult.content[0].text).toMatch(/cleared|Successfully/i);
      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'self-improve-state.json');
      expect(existsSync(statePath)).toBe(false);
    });

    it('state_get_status reports self-improve as active when state file is present', async () => {
      await stateWriteTool.handler({
        mode: 'self-improve',
        active: true,
        state: { tournament_round: 2 },
        workingDirectory: TEST_DIR,
      });

      const result = await stateGetStatusTool.handler({
        mode: 'self-improve',
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('Status: self-improve');
      expect(result.content[0].text).toContain('**Active:** Yes');
    });

    it('state_get_status reports deep-interview as active when state file is present', async () => {
      await stateWriteTool.handler({
        mode: 'deep-interview',
        active: true,
        state: { current_phase: 'contrarian' },
        workingDirectory: TEST_DIR,
      });

      const result = await stateGetStatusTool.handler({
        mode: 'deep-interview',
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('Status: deep-interview');
      expect(result.content[0].text).toContain('**Active:** Yes');
    });

    it('deep-interview session isolation: write to session A does not appear under session B', async () => {
      const sessionA = 'di-iso-a';
      const sessionB = 'di-iso-b';

      await stateWriteTool.handler({
        mode: 'deep-interview',
        active: true,
        state: { current_phase: 'questioning' },
        session_id: sessionA,
        workingDirectory: TEST_DIR,
      });

      const resultB = await stateReadTool.handler({
        mode: 'deep-interview',
        session_id: sessionB,
        workingDirectory: TEST_DIR,
      });

      expect(resultB.content[0].text).toContain('No state found');
    });

    it('self-improve session isolation: write to session A does not appear under session B', async () => {
      const sessionA = 'si-iso-a';
      const sessionB = 'si-iso-b';

      await stateWriteTool.handler({
        mode: 'self-improve',
        active: true,
        state: { tournament_round: 1 },
        session_id: sessionA,
        workingDirectory: TEST_DIR,
      });

      const resultB = await stateReadTool.handler({
        mode: 'self-improve',
        session_id: sessionB,
        workingDirectory: TEST_DIR,
      });

      expect(resultB.content[0].text).toContain('No state found');
    });
  });

  describe('state_get_status', () => {
    it('should return status for specific mode', async () => {
      const result = await stateGetStatusTool.handler({
        mode: 'ralph',
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('Status: ralph');
      expect(result.content[0].text).toContain('Active:');
    });

    it('should return all mode statuses when no mode specified', async () => {
      const result = await stateGetStatusTool.handler({
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('All Mode Statuses');
      expect(
        result.content[0].text.includes('[ACTIVE]') || result.content[0].text.includes('[INACTIVE]')
      ).toBe(true);
    });
  });

  describe('session_id parameter', () => {
    it('should write state with explicit session_id to session-scoped path', async () => {
      const sessionId = 'test-session-123';
      const result = await stateWriteTool.handler({
        mode: 'ultrawork',
        state: { active: true },
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('Successfully wrote');
      const sessionPath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'ultrawork-state.json');
      expect(existsSync(sessionPath)).toBe(true);
    });

    it('should read state with explicit session_id from session-scoped path', async () => {
      const sessionId = 'test-session-read';
      const sessionDir = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, 'ralph-state.json'),
        JSON.stringify({ active: true, session_id: sessionId })
      );

      const result = await stateReadTool.handler({
        mode: 'ralph',
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('active');
    });

    it('should clear session-specific state without affecting legacy owned by another session', async () => {
      const sessionId = 'test-session-clear';
      const otherSessionId = 'other-session-owner';

      // Create legacy state owned by a different session
      writeFileSync(
        join(TEST_DIR, '.omc', 'state', 'ralph-state.json'),
        JSON.stringify({ active: true, source: 'legacy', _meta: { sessionId: otherSessionId } })
      );
      const sessionDir = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, 'ralph-state.json'),
        JSON.stringify({ active: true, source: 'session' })
      );

      const result = await stateClearTool.handler({
        mode: 'ralph',
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('cleared');
      // Session-scoped file should be gone
      expect(existsSync(join(sessionDir, 'ralph-state.json'))).toBe(false);
      // Legacy file should remain (belongs to different session)
      expect(existsSync(join(TEST_DIR, '.omc', 'state', 'ralph-state.json'))).toBe(true);
    });

    it('should clear recovered session-owned state stranded under another session directory', async () => {
      const sessionId = 'continued-session';
      const strandedDir = join(TEST_DIR, '.omc', 'state', 'sessions', 'stale-session-dir');
      mkdirSync(strandedDir, { recursive: true });
      writeFileSync(
        join(strandedDir, 'ralph-state.json'),
        JSON.stringify({ active: true, session_id: sessionId, source: 'recovered-session-state' })
      );

      const result = await stateClearTool.handler({
        mode: 'ralph',
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('recovered session file');
      expect(existsSync(join(strandedDir, 'ralph-state.json'))).toBe(false);
    });

    it('should clear ralph stop-hook runtime artifacts with session-scoped cancel cleanup', async () => {
      const sessionId = 'ralph-stop-artifact-session';
      const stateDir = join(TEST_DIR, '.omc', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, 'ralph-state.json'),
        JSON.stringify({ active: true, session_id: sessionId }),
      );
      writeFileSync(join(sessionDir, 'ralph-stop-breaker.json'), JSON.stringify({ count: 3 }));
      writeFileSync(join(stateDir, 'ralph-stop-breaker.json'), JSON.stringify({ count: 3 }));
      writeFileSync(join(stateDir, 'ralph-last-steer-at'), new Date().toISOString());
      writeFileSync(join(stateDir, 'ralph-continue-steer.lock'), `${process.pid}`);

      const result = await stateClearTool.handler({
        mode: 'ralph',
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('runtime artifact');
      expect(existsSync(join(sessionDir, 'ralph-state.json'))).toBe(false);
      expect(existsSync(join(sessionDir, 'ralph-stop-breaker.json'))).toBe(false);
      expect(existsSync(join(stateDir, 'ralph-stop-breaker.json'))).toBe(false);
      expect(existsSync(join(stateDir, 'ralph-last-steer-at'))).toBe(false);
      expect(existsSync(join(stateDir, 'ralph-continue-steer.lock'))).toBe(false);
    });

    it('targets a recovered named workflow candidate in the cancel signal', async () => {
      const sessionId = 'recovered-workflow-owner';
      const strandedPath = join(TEST_DIR, '.omc', 'state', 'sessions', 'stale-workflow-dir', 'autopilot-state.json');
      mkdirSync(dirname(strandedPath), { recursive: true });
      writeFileSync(strandedPath, JSON.stringify({ active: true, session_id: sessionId }));

      await stateClearTool.handler({ mode: 'autopilot', session_id: sessionId, workingDirectory: TEST_DIR });
      const signalPath = join(dirname(strandedPath), 'cancel-signal-state.json');
      expect(JSON.parse(readFileSync(signalPath, 'utf8')).target_workflow_run_id).toBeUndefined();
      expect(existsSync(strandedPath)).toBe(false);
    });

    it('does not clear a singleton live autopilot owned by another active session', async () => {
      const currentSessionId = 'fresh-autopilot-cancel-session';
      const ownerSessionId = 'live-autopilot-owner-session';
      const ownerDir = join(TEST_DIR, '.omc', 'state', 'sessions', ownerSessionId);
      mkdirSync(ownerDir, { recursive: true });
      writeFileSync(
        join(ownerDir, 'autopilot-state.json'),
        JSON.stringify({
          active: true,
          session_id: ownerSessionId,
          phase: 'execution',
          current_phase: 'execution',
        }),
      );

      const result = await stateClearTool.handler({
        mode: 'autopilot',
        session_id: currentSessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('No state found to clear for mode: autopilot');
      expect(result.content[0].text).toContain('Checked paths');
      expect(existsSync(join(ownerDir, 'autopilot-state.json'))).toBe(true);
      expect(existsSync(join(TEST_DIR, '.omc', 'state', 'sessions', currentSessionId, 'cancel-signal-state.json'))).toBe(true);
      expect(existsSync(join(ownerDir, 'cancel-signal-state.json'))).toBe(false);
    });

    it('should clear the owning session when the current session resumed ralph from a different conversation', async () => {
      const currentSessionId = 'resume-session-b';
      const ownerSessionId = 'resume-session-a';
      const ownerDir = join(TEST_DIR, '.omc', 'state', 'sessions', ownerSessionId);
      mkdirSync(ownerDir, { recursive: true });
      writeFileSync(
        join(ownerDir, 'ralph-state.json'),
        JSON.stringify({
          active: true,
          session_id: ownerSessionId,
          iteration: 4,
          linked_ultrawork: true,
        }),
      );

      const result = await stateClearTool.handler({
        mode: 'ralph',
        session_id: currentSessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain(`cleared owning session: ${ownerSessionId}`);
      expect(existsSync(join(ownerDir, 'ralph-state.json'))).toBe(false);
      expect(existsSync(join(TEST_DIR, '.omc', 'state', 'sessions', currentSessionId, 'cancel-signal-state.json'))).toBe(true);
      expect(existsSync(join(ownerDir, 'cancel-signal-state.json'))).toBe(true);
    });

    it('should clear ralph runtime artifacts during broad cancel cleanup', async () => {
      const sessionId = 'ralph-broad-runtime-cleanup';
      const stateDir = join(TEST_DIR, '.omc', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, 'ralph-stop-breaker.json'), JSON.stringify({ count: 1 }));
      writeFileSync(join(stateDir, 'ralph-stop-breaker.json'), JSON.stringify({ count: 1 }));
      writeFileSync(join(stateDir, 'ralph-last-steer-at'), new Date().toISOString());

      const result = await stateClearTool.handler({
        mode: 'ralph',
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('Locations cleared: 3');
      expect(existsSync(join(sessionDir, 'ralph-stop-breaker.json'))).toBe(false);
      expect(existsSync(join(stateDir, 'ralph-stop-breaker.json'))).toBe(false);
      expect(existsSync(join(stateDir, 'ralph-last-steer-at'))).toBe(false);
    });

    it('reports no-op with checked paths when session clear finds no actual state file', async () => {
      const sessionId = 'missing-autopilot-state-session';
      const result = await stateClearTool.handler({
        mode: 'autopilot',
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('No state found to clear for mode: autopilot in session: missing-autopilot-state-session');
      expect(result.content[0].text).toContain('Checked paths');
      expect(result.content[0].text).toContain(join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json'));
    });

    it('clears autopilot state from the centralized OMC_STATE_DIR root used by stop hooks', async () => {
      const previous = process.env.OMC_STATE_DIR;
      const sessionId = 'centralized-autopilot-clear-session';
      const centralRoot = join(TEST_DIR, 'central-state-root');
      process.env.OMC_STATE_DIR = centralRoot;
      try {
        const { getOmcRoot } = await import('../../lib/worktree-paths.js');
        const autopilotPath = join(getOmcRoot(TEST_DIR), 'state', 'sessions', sessionId, 'autopilot-state.json');
        mkdirSync(join(autopilotPath, '..'), { recursive: true });
        writeFileSync(
          autopilotPath,
          JSON.stringify({
            active: true,
            session_id: sessionId,
            current_phase: 'execution',
          }),
        );

        const result = await stateClearTool.handler({
          mode: 'autopilot',
          session_id: sessionId,
          workingDirectory: TEST_DIR,
        });

        expect(result.content[0].text).toContain('Successfully cleared state for mode: autopilot in session: centralized-autopilot-clear-session');
        expect(existsSync(autopilotPath)).toBe(false);
      } finally {
        if (previous === undefined) {
          delete process.env.OMC_STATE_DIR;
        } else {
          process.env.OMC_STATE_DIR = previous;
        }
      }
    });

    it('clears workingDirectory-local ralph state when centralized OMC_STATE_DIR lookup misses', async () => {
      const previous = process.env.OMC_STATE_DIR;
      const sessionId = 'worktree-local-ralph-clear-session';
      const centralRoot = join(TEST_DIR, 'central-state-root');
      const localStatePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'ralph-state.json');
      process.env.OMC_STATE_DIR = centralRoot;
      try {
        mkdirSync(dirname(localStatePath), { recursive: true });
        writeFileSync(
          localStatePath,
          JSON.stringify({
            active: true,
            session_id: sessionId,
            iteration: 2,
          }),
        );

        const result = await stateClearTool.handler({
          mode: 'ralph',
          session_id: sessionId,
          workingDirectory: TEST_DIR,
        });

        expect(result.content[0].text).toContain('Successfully cleared state for mode: ralph');
        expect(result.content[0].text).toContain('workingDirectory-local state file');
        expect(existsSync(localStatePath)).toBe(false);
      } finally {
        if (previous === undefined) {
          delete process.env.OMC_STATE_DIR;
        } else {
          process.env.OMC_STATE_DIR = previous;
        }
      }
    });

    it('should discover and clear session-scoped autopilot state when no session_id is provided', async () => {
      const sessionId = 'missing-env-autopilot-session';
      const stateDir = join(TEST_DIR, '.omc', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      const autopilotPath = join(sessionDir, 'autopilot-state.json');
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        autopilotPath,
        JSON.stringify({
          active: true,
          session_id: sessionId,
          phase: 'expansion',
        }),
      );

      const result = await stateClearTool.handler({
        mode: 'autopilot',
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('Cleared state for mode: autopilot');
      expect(existsSync(autopilotPath)).toBe(false);
      expect(existsSync(join(sessionDir, 'cancel-signal-state.json'))).toBe(true);
    });
  });

  describe('session-scoped behavior', () => {
    it('should prevent cross-process state bleeding when session_id provided', async () => {
      // Simulate two processes writing to the same mode
      const processASessionId = 'pid-11111-1000000';
      const processBSessionId = 'pid-22222-2000000';

      // Process A writes
      await stateWriteTool.handler({
        mode: 'ultrawork',
        state: { active: true, task: 'Process A task' },
        session_id: processASessionId,
        workingDirectory: TEST_DIR,
      });

      // Process B writes
      await stateWriteTool.handler({
        mode: 'ultrawork',
        state: { active: true, task: 'Process B task' },
        session_id: processBSessionId,
        workingDirectory: TEST_DIR,
      });

      // Process A reads its own state
      const resultA = await stateReadTool.handler({
        mode: 'ultrawork',
        session_id: processASessionId,
        workingDirectory: TEST_DIR,
      });
      expect(resultA.content[0].text).toContain('Process A task');
      expect(resultA.content[0].text).not.toContain('Process B task');

      // Process B reads its own state
      const resultB = await stateReadTool.handler({
        mode: 'ultrawork',
        session_id: processBSessionId,
        workingDirectory: TEST_DIR,
      });
      expect(resultB.content[0].text).toContain('Process B task');
      expect(resultB.content[0].text).not.toContain('Process A task');
    });

    it('should write state to legacy path when session_id omitted', async () => {
      await stateWriteTool.handler({
        mode: 'ultrawork',
        state: { active: true },
        workingDirectory: TEST_DIR,
      });

      const legacyPath = join(TEST_DIR, '.omc', 'state', 'ultrawork-state.json');
      expect(existsSync(legacyPath)).toBe(true);
    });
  });

  describe('payload size validation', () => {
    it('should reject oversized custom state payloads', async () => {
      const result = await stateWriteTool.handler({
        mode: 'ralph',
        state: { huge: 'x'.repeat(2_000_000) },
        workingDirectory: TEST_DIR,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('payload rejected');
      expect(result.content[0].text).toContain('exceeds maximum');
    });

    it('should reject deeply nested custom state payloads', async () => {
      let obj: Record<string, unknown> = { leaf: true };
      for (let i = 0; i < 15; i++) {
        obj = { nested: obj };
      }

      const result = await stateWriteTool.handler({
        mode: 'ralph',
        state: obj,
        workingDirectory: TEST_DIR,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('nesting depth');
    });

    it('should reject state with too many top-level keys', async () => {
      const state: Record<string, string> = {};
      for (let i = 0; i < 150; i++) {
        state[`key_${i}`] = 'value';
      }

      const result = await stateWriteTool.handler({
        mode: 'ralph',
        state,
        workingDirectory: TEST_DIR,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('top-level keys');
    });

    it('should still allow normal-sized state writes', async () => {
      const result = await stateWriteTool.handler({
        mode: 'ralph',
        state: { active: true, task: 'normal task', items: [1, 2, 3] },
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('Successfully wrote');
    });

    it('should not validate when no custom state is provided', async () => {
      const result = await stateWriteTool.handler({
        mode: 'ralph',
        active: true,
        iteration: 1,
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('Successfully wrote');
    });
  });
});
