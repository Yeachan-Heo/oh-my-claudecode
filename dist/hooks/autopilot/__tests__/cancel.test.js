import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { join, sep } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { cancelAutopilot, clearAutopilot, canResumeAutopilot, resumeAutopilot, formatCancelMessage, STALE_STATE_MAX_AGE_MS } from '../cancel.js';
import { initAutopilot, transitionPhase, readAutopilotState, updateExecution, writeAutopilotState } from '../state.js';
import { createWorkflowDescriptor } from '../pipeline.js';
import { resolveSessionStatePath } from '../../../lib/worktree-paths.js';
import { validateNamedWorkflowState, validateNamedWorkflowStateStructure, } from '../named-workflow-resume-validator.js';
// Mock the ralph and ultraqa modules
vi.mock('../../ralph/index.js', () => ({
    clearRalphState: vi.fn(() => true),
    clearLinkedUltraworkState: vi.fn(() => true),
    readRalphState: vi.fn(() => null)
}));
vi.mock('../../ultraqa/index.js', () => ({
    clearUltraQAState: vi.fn(() => true),
    readUltraQAState: vi.fn(() => null)
}));
// Import mocked functions after vi.mock
import * as ralphLoop from '../../ralph/index.js';
import * as ultraqaLoop from '../../ultraqa/index.js';
describe('AutopilotCancel', () => {
    let testDir;
    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), 'autopilot-cancel-test-'));
        const fs = require('fs');
        fs.mkdirSync(join(testDir, '.omc', 'state'), { recursive: true });
        vi.clearAllMocks();
    });
    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
        delete process.env.OMC_TEST_CONDITIONAL_WRITE_REPLACEMENT_PATH;
        delete process.env.OMC_TEST_CONDITIONAL_WRITE_REPLACEMENT_BASE64;
        delete process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_PATH;
        delete process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_BASE64;
        delete process.env.OMC_TEST_FLOCK_AVAILABLE;
        delete process.env.OMC_TEST_EMERGENCY_CRASH_PHASE;
        delete process.env.CLAUDE_CONFIG_DIR;
        delete process.env.OMC_TEST_EMERGENCY_REPLACEMENT_PATH;
        delete process.env.OMC_TEST_EMERGENCY_REPLACEMENT_BASE64;
    });
    describe('cancelAutopilot', () => {
        it('should return failure when no state exists', () => {
            const result = cancelAutopilot(testDir);
            expect(result.success).toBe(false);
            expect(result.message).toBe('No active autopilot session found');
            expect(result.preservedState).toBeUndefined();
        });
        it('should return failure when state exists but is not active', () => {
            const state = initAutopilot(testDir, 'test idea');
            if (state) {
                state.active = false;
                const stateFile = join(testDir, '.omc', 'state', 'autopilot-state.json');
                const fs = require('fs');
                fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
            }
            const result = cancelAutopilot(testDir);
            expect(result.success).toBe(false);
            expect(result.message).toBe('Autopilot is not currently active');
            expect(result.preservedState).toBeUndefined();
        });
        it('should successfully cancel active autopilot and preserve state', () => {
            initAutopilot(testDir, 'test idea');
            const result = cancelAutopilot(testDir);
            expect(result.success).toBe(true);
            expect(result.message).toContain('Autopilot cancelled at phase: expansion');
            expect(result.message).toContain('Progress preserved for resume');
            expect(result.preservedState).toBeDefined();
            expect(result.preservedState?.active).toBe(false);
            expect(result.preservedState?.originalIdea).toBe('test idea');
        });
        it('should preserve state at different phases', () => {
            initAutopilot(testDir, 'test idea');
            transitionPhase(testDir, 'planning');
            const result = cancelAutopilot(testDir);
            expect(result.success).toBe(true);
            expect(result.message).toContain('Autopilot cancelled at phase: planning');
            expect(result.preservedState?.phase).toBe('planning');
        });
        it('should clean up ralph state when active', () => {
            initAutopilot(testDir, 'test idea');
            // Mock active ralph state
            vi.mocked(ralphLoop.readRalphState).mockReturnValueOnce({
                active: true,
                linked_ultrawork: false
            });
            const result = cancelAutopilot(testDir);
            expect(result.success).toBe(true);
            expect(result.message).toContain('Cleaned up: ralph');
            expect(ralphLoop.clearRalphState).toHaveBeenCalledWith(testDir);
        });
        it('should clean up ralph and ultrawork when linked', () => {
            initAutopilot(testDir, 'test idea');
            // Mock active ralph state with linked ultrawork
            vi.mocked(ralphLoop.readRalphState).mockReturnValueOnce({
                active: true,
                linked_ultrawork: true
            });
            const result = cancelAutopilot(testDir);
            expect(result.success).toBe(true);
            expect(result.message).toContain('Cleaned up: ultrawork, ralph');
            expect(ralphLoop.clearLinkedUltraworkState).toHaveBeenCalledWith(testDir);
            expect(ralphLoop.clearRalphState).toHaveBeenCalledWith(testDir);
        });
        it('should clean up ultraqa state when active', () => {
            initAutopilot(testDir, 'test idea');
            // Mock active ultraqa state
            vi.mocked(ultraqaLoop.readUltraQAState).mockReturnValueOnce({
                active: true
            });
            const result = cancelAutopilot(testDir);
            expect(result.success).toBe(true);
            expect(result.message).toContain('Cleaned up: ultraqa');
            expect(ultraqaLoop.clearUltraQAState).toHaveBeenCalledWith(testDir);
        });
        it('should clean up all states when all are active', () => {
            initAutopilot(testDir, 'test idea');
            // Mock all states active
            vi.mocked(ralphLoop.readRalphState).mockReturnValueOnce({
                active: true,
                linked_ultrawork: true
            });
            vi.mocked(ultraqaLoop.readUltraQAState).mockReturnValueOnce({
                active: true
            });
            const result = cancelAutopilot(testDir);
            expect(result.success).toBe(true);
            expect(result.message).toContain('Cleaned up: ultrawork, ralph, ultraqa');
            expect(ralphLoop.clearLinkedUltraworkState).toHaveBeenCalledWith(testDir);
            expect(ralphLoop.clearRalphState).toHaveBeenCalledWith(testDir);
            expect(ultraqaLoop.clearUltraQAState).toHaveBeenCalledWith(testDir);
        });
        it('should mark autopilot as inactive but keep state on disk', () => {
            initAutopilot(testDir, 'test idea');
            cancelAutopilot(testDir);
            const state = readAutopilotState(testDir);
            expect(state).not.toBeNull();
            expect(state?.active).toBe(false);
            expect(state?.originalIdea).toBe('test idea');
        });
        it('does not clear a replacement run in the same session', () => {
            const sessionId = 'same-session-clear-replacement';
            const observed = initAutopilot(testDir, 'old run', sessionId);
            writeAutopilotState(testDir, observed, sessionId);
            const statePath = join(testDir, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');
            const replacement = { ...observed, originalIdea: 'replacement run' };
            process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_PATH = statePath;
            process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_BASE64 = Buffer.from(JSON.stringify(replacement)).toString('base64');
            expect(clearAutopilot(testDir, sessionId).success).toBe(false);
            expect(readAutopilotState(testDir, sessionId)).toMatchObject({ active: true, originalIdea: 'replacement run' });
        });
        it('preserves malformed marker-bearing state bytes and linked state', () => {
            const sessionId = 'named-cancel-platform-gate';
            const state = initAutopilot(testDir, 'ship it', sessionId);
            state.workflow = createWorkflowDescriptor('release-flow', { version: 1, stages: ['ralplan', 'execution'] });
            state.workflowRunId = '11111111-1111-4111-8111-111111111111';
            writeAutopilotState(testDir, state, sessionId);
            const statePath = resolveSessionStatePath('autopilot', sessionId, testDir);
            const before = require('fs').readFileSync(statePath);
            expect(cancelAutopilot(testDir, sessionId)).toMatchObject({ success: false, message: 'workflow_descriptor_integrity_failed' });
            expect(require('fs').readFileSync(statePath)).toEqual(before);
            expect(ralphLoop.clearRalphState).not.toHaveBeenCalled();
            expect(ralphLoop.clearLinkedUltraworkState).not.toHaveBeenCalled();
            expect(ultraqaLoop.clearUltraQAState).not.toHaveBeenCalled();
        });
        it('cancels a structurally valid exact named run', () => {
            const sessionId = 'named-exact-cancel';
            const state = initAutopilot(testDir, 'ship it', sessionId);
            const transcriptRoot = join(testDir, 'transcripts');
            const transcriptPath = join(transcriptRoot, `${sessionId}.jsonl`);
            const identity = { device: 1, inode: 1, size: 0, mtimeNs: '0', ctimeNs: '0', contentSha256: createHash('sha256').update('').digest('hex') };
            Object.assign(state, {
                phase: 'ralplan',
                prompt: 'ship it',
                workflow: createWorkflowDescriptor('release-flow', { version: 1, stages: ['ralplan', 'execution'] }),
                workflowRunId: '11111111-1111-4111-8111-111111111111',
                pipelineTracking: {
                    stages: [{ id: 'ralplan', status: 'active', iterations: 0, startedAt: new Date().toISOString() }, { id: 'execution', status: 'pending', iterations: 0 }],
                    currentStageIndex: 0,
                    trackingRevision: 0,
                    activationBoundary: { transcriptPath, transcriptRoot, transcriptBasename: `${sessionId}.jsonl`, sessionId, byteOffset: 0, fileIdentity: identity },
                    completionObservations: [],
                },
            });
            writeAutopilotState(testDir, state, sessionId);
            const ralplanStatePath = join(testDir, '.omc', 'state', 'sessions', sessionId, 'ralplan-state.json');
            writeFileSync(ralplanStatePath, JSON.stringify({ active: true, session_id: sessionId, current_phase: 'ralplan' }));
            expect(validateNamedWorkflowStateStructure(readAutopilotState(testDir, sessionId), sessionId)).not.toBeNull();
            process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
            expect(cancelAutopilot(testDir, sessionId)).toMatchObject({ success: true, preservedState: { active: false, workflowRunId: state.workflowRunId } });
            expect(readAutopilotState(testDir, sessionId)).toMatchObject({ active: false, workflowRunId: state.workflowRunId });
            expect(existsSync(ralplanStatePath)).toBe(false);
        });
        it('does not pause a replacement named run without flock before linked cleanup', () => {
            const sessionId = 'portable-named-replacement';
            const state = initAutopilot(testDir, 'ship it', sessionId);
            const transcriptRoot = join(testDir, 'transcripts');
            const identity = { device: 1, inode: 1, size: 0, mtimeNs: '0', ctimeNs: '0', contentSha256: createHash('sha256').update('').digest('hex') };
            Object.assign(state, {
                phase: 'ralplan',
                prompt: 'ship it',
                workflow: createWorkflowDescriptor('release-flow', { version: 1, stages: ['ralplan', 'execution'] }),
                workflowRunId: '11111111-1111-4111-8111-111111111111',
                pipelineTracking: {
                    stages: [{ id: 'ralplan', status: 'active', iterations: 0, startedAt: new Date().toISOString() }, { id: 'execution', status: 'pending', iterations: 0 }],
                    currentStageIndex: 0,
                    trackingRevision: 0,
                    activationBoundary: { transcriptPath: join(transcriptRoot, `${sessionId}.jsonl`), transcriptRoot, transcriptBasename: `${sessionId}.jsonl`, sessionId, byteOffset: 0, fileIdentity: identity },
                    completionObservations: [],
                },
            });
            writeAutopilotState(testDir, state, sessionId);
            const statePath = resolveSessionStatePath('autopilot', sessionId, testDir);
            const replacement = { ...state, originalIdea: 'replacement run' };
            process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
            process.env.OMC_TEST_EMERGENCY_REPLACEMENT_PATH = statePath;
            process.env.OMC_TEST_EMERGENCY_REPLACEMENT_BASE64 = Buffer.from(JSON.stringify(replacement)).toString('base64');
            expect(cancelAutopilot(testDir, sessionId)).toMatchObject({ success: false, message: 'Autopilot run changed before cancellation; retry /cancel.' });
            expect(readAutopilotState(testDir, sessionId)).toMatchObject({ active: true, originalIdea: 'replacement run' });
            expect(ralphLoop.clearRalphState).not.toHaveBeenCalled();
            expect(ultraqaLoop.clearUltraQAState).not.toHaveBeenCalled();
        });
        it('does not clean linked state when the primary named mutation lock is held', () => {
            const sessionId = 'named-primary-lock';
            const state = initAutopilot(testDir, 'ship it', sessionId);
            state.workflow = createWorkflowDescriptor('release-flow', { version: 1, stages: ['ralplan', 'execution'] });
            state.workflowRunId = '11111111-1111-4111-8111-111111111111';
            writeAutopilotState(testDir, state, sessionId);
            const statePath = resolveSessionStatePath('autopilot', sessionId, testDir);
            const stat = require('fs').readFileSync(`/proc/${process.pid}/stat`, 'utf8');
            const processStart = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
            writeFileSync(`${statePath}.mutation.lock`, JSON.stringify({ version: 1, pid: process.pid, processStart, createdAt: new Date().toISOString(), nonce: '22222222-2222-4222-8222-222222222222' }));
            expect(cancelAutopilot(testDir, sessionId).success).toBe(false);
            expect(clearAutopilot(testDir, sessionId).success).toBe(false);
            expect(ralphLoop.clearRalphState).not.toHaveBeenCalled();
            expect(ralphLoop.clearLinkedUltraworkState).not.toHaveBeenCalled();
            expect(ultraqaLoop.clearUltraQAState).not.toHaveBeenCalled();
            expect(readAutopilotState(testDir, sessionId)).toMatchObject({ active: true, workflowRunId: state.workflowRunId });
        });
        it('retries failed dependent cleanup for an already-paused named run', () => {
            const sessionId = 'dependent-cleanup-failure';
            const state = initAutopilot(testDir, 'ship it', sessionId);
            const transcriptRoot = join(testDir, 'transcripts');
            const identity = { device: 1, inode: 1, size: 0, mtimeNs: '0', ctimeNs: '0', contentSha256: createHash('sha256').update('').digest('hex') };
            Object.assign(state, {
                phase: 'ralplan',
                prompt: 'ship it',
                workflow: createWorkflowDescriptor('release-flow', { version: 1, stages: ['ralplan', 'execution'] }),
                workflowRunId: '11111111-1111-4111-8111-111111111111',
                pipelineTracking: {
                    stages: [{ id: 'ralplan', status: 'active', iterations: 0, startedAt: new Date().toISOString() }, { id: 'execution', status: 'pending', iterations: 0 }],
                    currentStageIndex: 0,
                    trackingRevision: 0,
                    activationBoundary: { transcriptPath: join(transcriptRoot, `${sessionId}.jsonl`), transcriptRoot, transcriptBasename: `${sessionId}.jsonl`, sessionId, byteOffset: 0, fileIdentity: identity },
                    completionObservations: [],
                },
            });
            writeAutopilotState(testDir, state, sessionId);
            vi.mocked(ralphLoop.readRalphState).mockReturnValue({ active: true, linked_ultrawork: true });
            vi.mocked(ralphLoop.clearLinkedUltraworkState).mockReturnValueOnce(false);
            const cancelled = cancelAutopilot(testDir, sessionId);
            expect(cancelled).toMatchObject({ success: false, preservedState: { active: false, workflowRunId: state.workflowRunId } });
            expect(cancelled.message).toContain('ultrawork');
            expect(ralphLoop.clearRalphState).not.toHaveBeenCalled();
            const retried = cancelAutopilot(testDir, sessionId);
            expect(retried).toMatchObject({ success: true, preservedState: { active: false, workflowRunId: state.workflowRunId } });
            expect(readAutopilotState(testDir, sessionId)).toMatchObject({ active: false, workflowRunId: state.workflowRunId });
            expect(ralphLoop.clearLinkedUltraworkState).toHaveBeenCalledTimes(2);
            expect(ralphLoop.clearRalphState).toHaveBeenCalledWith(testDir, sessionId);
        });
        it('should not clear other session ralph/ultraqa state when sessionId provided', () => {
            const sessionId = 'session-a';
            initAutopilot(testDir, 'test idea', sessionId);
            vi.mocked(ralphLoop.readRalphState).mockReturnValueOnce(null);
            vi.mocked(ultraqaLoop.readUltraQAState).mockReturnValueOnce(null);
            cancelAutopilot(testDir, sessionId);
            expect(ralphLoop.readRalphState).toHaveBeenCalledWith(testDir, sessionId);
            expect(ultraqaLoop.readUltraQAState).toHaveBeenCalledWith(testDir, sessionId);
            expect(ralphLoop.clearRalphState).not.toHaveBeenCalled();
            expect(ralphLoop.clearLinkedUltraworkState).not.toHaveBeenCalled();
            expect(ultraqaLoop.clearUltraQAState).not.toHaveBeenCalled();
        });
    });
    describe('clearAutopilot', () => {
        it('should return success when no state exists', () => {
            const result = clearAutopilot(testDir);
            expect(result.success).toBe(true);
            expect(result.message).toBe('No autopilot state to clear');
        });
        it('should clear all autopilot state completely', () => {
            initAutopilot(testDir, 'test idea');
            const result = clearAutopilot(testDir);
            expect(result.success).toBe(true);
            expect(result.message).toBe('Autopilot state cleared completely');
            const state = readAutopilotState(testDir);
            expect(state).toBeNull();
        });
        it('should clear ralph state when present', () => {
            initAutopilot(testDir, 'test idea');
            // Mock ralph state exists
            vi.mocked(ralphLoop.readRalphState).mockReturnValueOnce({
                active: true,
                linked_ultrawork: false
            });
            clearAutopilot(testDir);
            expect(ralphLoop.clearRalphState).toHaveBeenCalledWith(testDir);
        });
        it('should clear ralph and linked ultrawork state when present', () => {
            initAutopilot(testDir, 'test idea');
            // Mock ralph state with linked ultrawork
            vi.mocked(ralphLoop.readRalphState).mockReturnValueOnce({
                active: false,
                linked_ultrawork: true
            });
            clearAutopilot(testDir);
            expect(ralphLoop.clearLinkedUltraworkState).toHaveBeenCalledWith(testDir);
            expect(ralphLoop.clearRalphState).toHaveBeenCalledWith(testDir);
        });
        it('should clear ultraqa state when present', () => {
            initAutopilot(testDir, 'test idea');
            // Mock ultraqa state exists
            vi.mocked(ultraqaLoop.readUltraQAState).mockReturnValueOnce({
                active: false
            });
            clearAutopilot(testDir);
            expect(ultraqaLoop.clearUltraQAState).toHaveBeenCalledWith(testDir);
        });
        it('should clear all states when all are present', () => {
            initAutopilot(testDir, 'test idea');
            // Mock all states exist
            vi.mocked(ralphLoop.readRalphState).mockReturnValueOnce({
                active: true,
                linked_ultrawork: true
            });
            vi.mocked(ultraqaLoop.readUltraQAState).mockReturnValueOnce({
                active: true
            });
            clearAutopilot(testDir);
            expect(ralphLoop.clearLinkedUltraworkState).toHaveBeenCalledWith(testDir);
            expect(ralphLoop.clearRalphState).toHaveBeenCalledWith(testDir);
            expect(ultraqaLoop.clearUltraQAState).toHaveBeenCalledWith(testDir);
            const state = readAutopilotState(testDir);
            expect(state).toBeNull();
        });
        it('should not clear other session ralph/ultraqa state when sessionId provided', () => {
            const sessionId = 'session-a';
            initAutopilot(testDir, 'test idea', sessionId);
            vi.mocked(ralphLoop.readRalphState).mockReturnValueOnce(null);
            vi.mocked(ultraqaLoop.readUltraQAState).mockReturnValueOnce(null);
            clearAutopilot(testDir, sessionId);
            expect(ralphLoop.readRalphState).toHaveBeenCalledWith(testDir, sessionId);
            expect(ultraqaLoop.readUltraQAState).toHaveBeenCalledWith(testDir, sessionId);
            expect(ralphLoop.clearRalphState).not.toHaveBeenCalled();
            expect(ralphLoop.clearLinkedUltraworkState).not.toHaveBeenCalled();
            expect(ultraqaLoop.clearUltraQAState).not.toHaveBeenCalled();
        });
    });
    describe('canResumeAutopilot', () => {
        it('should return false when no state exists', () => {
            const result = canResumeAutopilot(testDir);
            expect(result.canResume).toBe(false);
            expect(result.state).toBeUndefined();
            expect(result.resumePhase).toBeUndefined();
        });
        it('should return true for recently cancelled incomplete state', () => {
            initAutopilot(testDir, 'test idea');
            cancelAutopilot(testDir);
            const result = canResumeAutopilot(testDir);
            expect(result.canResume).toBe(true);
            expect(result.state).toBeDefined();
            expect(result.resumePhase).toBe('expansion');
        });
        it('should return true for recently cancelled planning state', () => {
            initAutopilot(testDir, 'test idea');
            transitionPhase(testDir, 'planning');
            cancelAutopilot(testDir);
            const result = canResumeAutopilot(testDir);
            expect(result.canResume).toBe(true);
            expect(result.resumePhase).toBe('planning');
        });
        it('should return false for complete phase', () => {
            initAutopilot(testDir, 'test idea');
            transitionPhase(testDir, 'complete');
            const result = canResumeAutopilot(testDir);
            expect(result.canResume).toBe(false);
            expect(result.state).toBeDefined();
            expect(result.state?.phase).toBe('complete');
        });
        it('should return false for failed phase', () => {
            initAutopilot(testDir, 'test idea');
            transitionPhase(testDir, 'failed');
            const result = canResumeAutopilot(testDir);
            expect(result.canResume).toBe(false);
            expect(result.state).toBeDefined();
            expect(result.state?.phase).toBe('failed');
        });
        it('should return false for state that is still active (issue #609)', () => {
            initAutopilot(testDir, 'test idea');
            // State is active: true — do NOT cancel, simulate another session seeing this
            const result = canResumeAutopilot(testDir);
            expect(result.canResume).toBe(false);
            expect(result.state).toBeDefined();
            expect(result.state?.active).toBe(true);
        });
        it('should return false for stale cancelled state older than 1 hour (issue #609)', () => {
            initAutopilot(testDir, 'test idea');
            cancelAutopilot(testDir);
            // Age the state file to be older than the stale threshold
            const stateFile = join(testDir, '.omc', 'state', 'autopilot-state.json');
            const pastTime = new Date(Date.now() - STALE_STATE_MAX_AGE_MS - 60_000);
            utimesSync(stateFile, pastTime, pastTime);
            const result = canResumeAutopilot(testDir);
            expect(result.canResume).toBe(false);
        });
        it('should auto-cleanup stale state file (issue #609)', () => {
            initAutopilot(testDir, 'test idea');
            cancelAutopilot(testDir);
            // Age the state file
            const stateFile = join(testDir, '.omc', 'state', 'autopilot-state.json');
            const pastTime = new Date(Date.now() - STALE_STATE_MAX_AGE_MS - 60_000);
            utimesSync(stateFile, pastTime, pastTime);
            canResumeAutopilot(testDir);
            // State file should be deleted after stale detection
            const state = readAutopilotState(testDir);
            expect(state).toBeNull();
        });
        it('does not let stale resume cleanup delete a replacement run', () => {
            const observed = initAutopilot(testDir, 'old run');
            observed.active = false;
            writeAutopilotState(testDir, observed);
            const stateFile = join(testDir, '.omc', 'state', 'autopilot-state.json');
            const pastTime = new Date(Date.now() - STALE_STATE_MAX_AGE_MS - 60_000);
            utimesSync(stateFile, pastTime, pastTime);
            const replacement = { ...observed, active: true, originalIdea: 'replacement run' };
            process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_PATH = stateFile;
            process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_BASE64 = Buffer.from(JSON.stringify(replacement)).toString('base64');
            expect(canResumeAutopilot(testDir).canResume).toBe(false);
            expect(readAutopilotState(testDir)).toMatchObject({ active: true, originalIdea: 'replacement run' });
        });
        it('should allow resume for recently cancelled state within 1 hour', () => {
            initAutopilot(testDir, 'test idea');
            transitionPhase(testDir, 'execution');
            cancelAutopilot(testDir);
            // File is fresh — well within the 1 hour window
            const result = canResumeAutopilot(testDir);
            expect(result.canResume).toBe(true);
            expect(result.resumePhase).toBe('execution');
        });
    });
    describe('resumeAutopilot', () => {
        it('should return failure when no state exists', () => {
            const result = resumeAutopilot(testDir);
            expect(result.success).toBe(false);
            expect(result.message).toBe('No autopilot session available to resume');
            expect(result.state).toBeUndefined();
        });
        it('should return failure when state is complete', () => {
            initAutopilot(testDir, 'test idea');
            transitionPhase(testDir, 'complete');
            const result = resumeAutopilot(testDir);
            expect(result.success).toBe(false);
            expect(result.message).toBe('No autopilot session available to resume');
        });
        it('should return failure when state is failed', () => {
            initAutopilot(testDir, 'test idea');
            transitionPhase(testDir, 'failed');
            const result = resumeAutopilot(testDir);
            expect(result.success).toBe(false);
            expect(result.message).toBe('No autopilot session available to resume');
        });
        it('should successfully resume from expansion phase', () => {
            initAutopilot(testDir, 'test idea');
            cancelAutopilot(testDir); // Cancel to make it inactive
            const result = resumeAutopilot(testDir);
            expect(result.success).toBe(true);
            expect(result.message).toBe('Resuming autopilot at phase: expansion');
            expect(result.state).toBeDefined();
            expect(result.state?.active).toBe(true);
            expect(result.state?.iteration).toBe(2);
        });
        it('should successfully resume from planning phase', () => {
            initAutopilot(testDir, 'test idea');
            transitionPhase(testDir, 'planning');
            cancelAutopilot(testDir);
            const result = resumeAutopilot(testDir);
            expect(result.success).toBe(true);
            expect(result.message).toBe('Resuming autopilot at phase: planning');
            expect(result.state?.phase).toBe('planning');
            expect(result.state?.active).toBe(true);
        });
        it('should increment iteration on resume', () => {
            initAutopilot(testDir, 'test idea');
            let state = readAutopilotState(testDir);
            const initialIteration = state?.iteration ?? 0;
            cancelAutopilot(testDir);
            resumeAutopilot(testDir);
            state = readAutopilotState(testDir);
            expect(state?.iteration).toBe(initialIteration + 1);
        });
        it('should re-activate state on resume', () => {
            initAutopilot(testDir, 'test idea');
            cancelAutopilot(testDir);
            let state = readAutopilotState(testDir);
            expect(state?.active).toBe(false);
            resumeAutopilot(testDir);
            state = readAutopilotState(testDir);
            expect(state?.active).toBe(true);
        });
        it('should preserve all state data on resume', () => {
            initAutopilot(testDir, 'test idea');
            transitionPhase(testDir, 'execution');
            updateExecution(testDir, {
                files_created: ['file1.ts', 'file2.ts'],
                files_modified: ['file3.ts'],
                tasks_completed: 5,
                tasks_total: 10
            });
            cancelAutopilot(testDir);
            const result = resumeAutopilot(testDir);
            expect(result.success).toBe(true);
            expect(result.state?.execution.files_created).toEqual(['file1.ts', 'file2.ts']);
            expect(result.state?.execution.files_modified).toEqual(['file3.ts']);
            expect(result.state?.execution.tasks_completed).toBe(5);
            expect(result.state?.execution.tasks_total).toBe(10);
        });
        it('should refuse to resume stale state from a previous session (issue #609)', () => {
            initAutopilot(testDir, 'old idea from session A');
            transitionPhase(testDir, 'planning');
            cancelAutopilot(testDir);
            // Simulate passage of time — file is now older than 1 hour
            const stateFile = join(testDir, '.omc', 'state', 'autopilot-state.json');
            const pastTime = new Date(Date.now() - STALE_STATE_MAX_AGE_MS - 60_000);
            utimesSync(stateFile, pastTime, pastTime);
            const result = resumeAutopilot(testDir);
            expect(result.success).toBe(false);
            expect(result.message).toBe('No autopilot session available to resume');
        });
        it('should refuse to resume actively-running state (issue #609)', () => {
            initAutopilot(testDir, 'test idea');
            // Do NOT cancel — state is still active: true
            const result = resumeAutopilot(testDir);
            expect(result.success).toBe(false);
            expect(result.message).toBe('No autopilot session available to resume');
        });
        it('rejects a descriptor-less paused workflow marker without mutating bytes', () => {
            const state = initAutopilot(testDir, 'test idea');
            state.active = false;
            state.workflowRunId = '11111111-1111-4111-8111-111111111111';
            writeAutopilotState(testDir, state);
            const stateFile = join(testDir, '.omc', 'state', 'autopilot-state.json');
            const before = require('fs').readFileSync(stateFile);
            expect(canResumeAutopilot(testDir)).toMatchObject({ canResume: false, integrityFailed: true });
            expect(resumeAutopilot(testDir)).toMatchObject({ success: false, message: 'workflow_descriptor_integrity_failed' });
            expect(require('fs').readFileSync(stateFile)).toEqual(before);
        });
        it('does not mutate an invalid named paused state when runtime support is unavailable', () => {
            const state = initAutopilot(testDir, 'test idea');
            state.active = false;
            state.workflow = createWorkflowDescriptor('release-flow', { version: 1, stages: ['ralplan', 'execution'] });
            writeAutopilotState(testDir, state);
            const stateFile = join(testDir, '.omc', 'state', 'autopilot-state.json');
            const before = require('fs').readFileSync(stateFile);
            process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
            expect(resumeAutopilot(testDir)).toMatchObject({ success: false, message: 'workflow_descriptor_integrity_failed' });
            expect(require('fs').readFileSync(stateFile)).toEqual(before);
        });
        it('rejects a named traversal boundary without mutating paused bytes', () => {
            const sessionId = 'resume-auth-session';
            const root = join(testDir, 'claude-config', 'projects');
            process.env.CLAUDE_CONFIG_DIR = join(testDir, 'claude-config');
            mkdirSync(root, { recursive: true });
            const encodedProject = join(root, '-workspace-project');
            mkdirSync(encodedProject);
            const transcript = join(encodedProject, `${sessionId}.jsonl`);
            writeFileSync(transcript, '');
            const stat = statSync(transcript);
            const state = initAutopilot(testDir, 'ship it', sessionId);
            const descriptor = createWorkflowDescriptor('release-flow', { version: 1, stages: ['ralplan', 'execution'] });
            const identity = { device: stat.dev, inode: stat.ino, size: 0, mtimeNs: '0', ctimeNs: '0', contentSha256: createHash('sha256').update('').digest('hex') };
            Object.assign(state, { active: false, phase: 'ralplan', prompt: 'ship it', workflow: descriptor, workflowRunId: '11111111-1111-4111-8111-111111111111', pipelineTracking: { stages: [{ id: 'ralplan', status: 'active', iterations: 0, startedAt: new Date().toISOString() }, { id: 'execution', status: 'pending', iterations: 0 }], currentStageIndex: 0, trackingRevision: 0, activationBoundary: { transcriptPath: `${encodedProject}${sep}nested${sep}..${sep}${sessionId}.jsonl`, transcriptRoot: root, transcriptBasename: `${sessionId}.jsonl`, sessionId, byteOffset: 0, fileIdentity: identity }, completionObservations: [] } });
            writeAutopilotState(testDir, state, sessionId);
            const stateFile = resolveSessionStatePath('autopilot', sessionId, testDir);
            const before = require('fs').readFileSync(stateFile);
            expect(resumeAutopilot(testDir, sessionId)).toMatchObject({ success: false, message: 'workflow_descriptor_integrity_failed' });
            expect(require('fs').readFileSync(stateFile)).toEqual(before);
            state.pipelineTracking.activationBoundary.transcriptPath = transcript;
            writeAutopilotState(testDir, state, sessionId);
            const target = join(encodedProject, 'target.jsonl');
            writeFileSync(target, '');
            rmSync(transcript);
            symlinkSync(target, transcript);
            const symlinkBytes = require('fs').readFileSync(stateFile);
            expect(resumeAutopilot(testDir, sessionId)).toMatchObject({ success: false, message: 'workflow_descriptor_integrity_failed' });
            expect(require('fs').readFileSync(stateFile)).toEqual(symlinkBytes);
            rmSync(transcript);
            writeFileSync(transcript, '');
            const validStat = statSync(transcript);
            Object.assign(state.pipelineTracking.activationBoundary.fileIdentity, { device: validStat.dev, inode: validStat.ino });
            state.pipelineTracking.activationBoundary.transcriptPath = transcript;
            writeAutopilotState(testDir, state, sessionId);
            const replacement = structuredClone(state);
            replacement.pipelineTracking.activationBoundary.transcriptPath = `${encodedProject}${sep}nested${sep}..${sep}${sessionId}.jsonl`;
            process.env.OMC_TEST_CONDITIONAL_WRITE_REPLACEMENT_PATH = stateFile;
            process.env.OMC_TEST_CONDITIONAL_WRITE_REPLACEMENT_BASE64 = Buffer.from(JSON.stringify(replacement)).toString('base64');
            expect(resumeAutopilot(testDir, sessionId)).toMatchObject({ success: false, message: 'workflow_descriptor_integrity_failed' });
            expect(readAutopilotState(testDir, sessionId)).toEqual(replacement);
            writeAutopilotState(testDir, state, sessionId);
            expect(validateNamedWorkflowState(readAutopilotState(testDir, sessionId), sessionId)).not.toBeNull();
            const finalResume = resumeAutopilot(testDir, sessionId);
            expect(finalResume.message).toBe('Resuming autopilot at phase: ralplan');
            expect(finalResume).toMatchObject({ success: true, state: { active: true, workflowRunId: state.workflowRunId } });
        });
        it('rejects forged completion observations and resumes an authenticated advanced named workflow', () => {
            const sessionId = 'resume-observation-session';
            const root = join(testDir, 'claude-config', 'projects');
            const project = join(root, '-workspace-project');
            const transcript = join(project, `${sessionId}.jsonl`);
            process.env.CLAUDE_CONFIG_DIR = join(testDir, 'claude-config');
            mkdirSync(project, { recursive: true });
            writeFileSync(transcript, '');
            const initial = statSync(transcript);
            const initialIdentity = { device: initial.dev, inode: initial.ino, size: 0, mtimeNs: '0', ctimeNs: '0', contentSha256: createHash('sha256').update('').digest('hex') };
            const state = initAutopilot(testDir, 'ship it', sessionId);
            const descriptor = createWorkflowDescriptor('release-flow', { version: 1, stages: ['ralplan', 'execution'] });
            const record = JSON.stringify({ sessionId, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Signal: PIPELINE_RALPLAN_COMPLETE' }] } });
            const content = Buffer.from(`${record}\n`);
            writeFileSync(transcript, content);
            const stable = statSync(transcript);
            const stableIdentity = { device: stable.dev, inode: stable.ino, size: stable.size, mtimeNs: '0', ctimeNs: '0', contentSha256: createHash('sha256').update(content).digest('hex') };
            const now = new Date().toISOString();
            Object.assign(state, { active: false, phase: 'execution', prompt: 'ship it', workflow: descriptor, workflowRunId: '11111111-1111-4111-8111-111111111111', pipelineTracking: { stages: [{ id: 'ralplan', status: 'complete', iterations: 0, startedAt: now, completedAt: now }, { id: 'execution', status: 'active', iterations: 0, startedAt: now }], currentStageIndex: 1, trackingRevision: 1, activationBoundary: { transcriptPath: transcript, transcriptRoot: root, transcriptBasename: `${sessionId}.jsonl`, sessionId, byteOffset: stable.size, fileIdentity: stableIdentity }, completionObservations: [{ stageId: 'ralplan', sessionId, signalId: 'PIPELINE_RALPLAN_COMPLETE', lineNumber: 0, byteOffset: 0, recordContentSha256: createHash('sha256').update(record).digest('hex'), stableFile: stableIdentity, activationBoundary: { transcriptPath: transcript, transcriptRoot: root, transcriptBasename: `${sessionId}.jsonl`, sessionId, byteOffset: 0, fileIdentity: initialIdentity }, observedAt: now }] } });
            writeAutopilotState(testDir, state, sessionId);
            expect(validateNamedWorkflowState(readAutopilotState(testDir, sessionId), sessionId)).not.toBeNull();
            const forged = structuredClone(state);
            forged.pipelineTracking.completionObservations[0].recordContentSha256 = '0'.repeat(64);
            writeAutopilotState(testDir, forged, sessionId);
            const stateFile = resolveSessionStatePath('autopilot', sessionId, testDir);
            const before = require('fs').readFileSync(stateFile);
            expect(resumeAutopilot(testDir, sessionId)).toMatchObject({ success: false, message: 'workflow_descriptor_integrity_failed' });
            expect(require('fs').readFileSync(stateFile)).toEqual(before);
            const skippedRecord = JSON.stringify({ sessionId, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Signal: PIPELINE_EXECUTION_COMPLETE' }] } });
            const skippedContent = Buffer.from(`${skippedRecord}\n`);
            writeFileSync(transcript, skippedContent);
            const skippedStat = statSync(transcript);
            const skippedIdentity = { device: skippedStat.dev, inode: skippedStat.ino, size: skippedStat.size, mtimeNs: '0', ctimeNs: '0', contentSha256: createHash('sha256').update(skippedContent).digest('hex') };
            const skipped = structuredClone(state);
            skipped.pipelineTracking.completionObservations[0].stableFile = skippedIdentity;
            skipped.pipelineTracking.completionObservations[0].recordContentSha256 = createHash('sha256').update(skippedRecord).digest('hex');
            skipped.pipelineTracking.activationBoundary.fileIdentity = skippedIdentity;
            skipped.pipelineTracking.activationBoundary.byteOffset = skippedIdentity.size;
            writeAutopilotState(testDir, skipped, sessionId);
            const skippedBefore = require('fs').readFileSync(stateFile);
            expect(resumeAutopilot(testDir, sessionId)).toMatchObject({ success: false, message: 'workflow_descriptor_integrity_failed' });
            expect(require('fs').readFileSync(stateFile)).toEqual(skippedBefore);
            writeFileSync(transcript, content);
            forged.pipelineTracking.completionObservations[0].recordContentSha256 = createHash('sha256').update(record).digest('hex');
            writeAutopilotState(testDir, forged, sessionId);
            expect(resumeAutopilot(testDir, sessionId)).toMatchObject({ success: true, state: { active: true, phase: 'execution' } });
        });
    });
    describe('formatCancelMessage', () => {
        it('should format failure message', () => {
            const result = {
                success: false,
                message: 'No active autopilot session found'
            };
            const formatted = formatCancelMessage(result);
            expect(formatted).toBe('[AUTOPILOT] No active autopilot session found');
        });
        it('should format success message without preserved state', () => {
            const result = {
                success: true,
                message: 'Autopilot state cleared completely'
            };
            const formatted = formatCancelMessage(result);
            expect(formatted).toContain('[AUTOPILOT CANCELLED]');
            expect(formatted).toContain('Autopilot state cleared completely');
            expect(formatted).not.toContain('Progress Summary');
        });
        it('should format success message with preserved state and progress summary', () => {
            const _state = initAutopilot(testDir, 'test idea');
            transitionPhase(testDir, 'execution');
            updateExecution(testDir, {
                files_created: ['file1.ts', 'file2.ts', 'file3.ts'],
                files_modified: ['file4.ts', 'file5.ts']
            });
            const updatedState = readAutopilotState(testDir);
            if (updatedState) {
                updatedState.total_agents_spawned = 7;
            }
            const result = {
                success: true,
                message: 'Autopilot cancelled at phase: execution. Progress preserved for resume.',
                preservedState: updatedState
            };
            const formatted = formatCancelMessage(result);
            expect(formatted).toContain('[AUTOPILOT CANCELLED]');
            expect(formatted).toContain('Autopilot cancelled at phase: execution');
            expect(formatted).toContain('Progress Summary:');
            expect(formatted).toContain('- Phase reached: execution');
            expect(formatted).toContain('- Files created: 3');
            expect(formatted).toContain('- Files modified: 2');
            expect(formatted).toContain('- Agents used: 7');
            expect(formatted).toContain('Run /autopilot to resume from where you left off.');
        });
        it('should handle zero progress in summary', () => {
            const state = initAutopilot(testDir, 'test idea');
            if (!state) {
                throw new Error('Failed to initialize autopilot');
            }
            const result = {
                success: true,
                message: 'Autopilot cancelled at phase: expansion. Progress preserved for resume.',
                preservedState: state
            };
            const formatted = formatCancelMessage(result);
            expect(formatted).toContain('- Files created: 0');
            expect(formatted).toContain('- Files modified: 0');
            expect(formatted).toContain('- Agents used: 0');
        });
        it('omits the legacy execution summary for a named workflow without execution metrics', () => {
            const state = initAutopilot(testDir, 'test named workflow');
            state.workflow = createWorkflowDescriptor('release-flow', { version: 1, stages: ['ralplan', 'execution'] });
            state.workflowRunId = '11111111-1111-4111-8111-111111111111';
            delete state.execution;
            const formatted = formatCancelMessage({
                success: true,
                message: 'Named workflow cancelled.',
                preservedState: state,
            });
            expect(formatted).toContain('[AUTOPILOT CANCELLED]');
            expect(formatted).not.toContain('Progress Summary:');
            expect(formatted).not.toContain('Files created:');
            expect(formatted).toContain('Run /autopilot to resume from where you left off.');
        });
        it('should handle cleanup message in preserved state format', () => {
            const state = initAutopilot(testDir, 'test idea');
            if (!state) {
                throw new Error('Failed to initialize autopilot');
            }
            state.active = false;
            const result = {
                success: true,
                message: 'Autopilot cancelled at phase: expansion. Cleaned up: ralph, ultrawork. Progress preserved for resume.',
                preservedState: state
            };
            const formatted = formatCancelMessage(result);
            expect(formatted).toContain('[AUTOPILOT CANCELLED]');
            expect(formatted).toContain('Cleaned up: ralph, ultrawork');
            expect(formatted).toContain('Progress Summary:');
        });
    });
});
//# sourceMappingURL=cancel.test.js.map