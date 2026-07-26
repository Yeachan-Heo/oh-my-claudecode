import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { readAutopilotState, clearAutopilotState, isAutopilotActive, initAutopilot, transitionPhase, updateAutopilotStateIfCurrent, updateExpansion, updateExecution, writeAutopilotState, } from "../state.js";
import { createWorkflowDescriptor } from "../pipeline.js";
import { validateNamedWorkflowStateStructure } from "../named-workflow-resume-validator.js";
describe("AutopilotState", () => {
    let testDir;
    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), "autopilot-test-"));
    });
    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
        delete process.env.OMC_TEST_FLOCK_AVAILABLE;
    });
    describe("readAutopilotState", () => {
        it("should return null when state file does not exist", () => {
            const state = readAutopilotState(testDir);
            expect(state).toBeNull();
        });
        it("should return parsed state when file exists", () => {
            const _state = initAutopilot(testDir, "test idea");
            const readState = readAutopilotState(testDir);
            expect(readState).not.toBeNull();
            expect(readState?.originalIdea).toBe("test idea");
        });
    });
    describe("initAutopilot", () => {
        it("should create new state with correct defaults", () => {
            const state = initAutopilot(testDir, "build a cli tool");
            expect(state).not.toBeNull();
            expect(state.active).toBe(true);
            expect(state.phase).toBe("expansion");
            expect(state.originalIdea).toBe("build a cli tool");
            expect(state.expansion.analyst_complete).toBe(false);
        });
    });
    describe("clearAutopilotState", () => {
        it("should delete state file", () => {
            initAutopilot(testDir, "test");
            expect(isAutopilotActive(testDir)).toBe(true);
            clearAutopilotState(testDir);
            expect(isAutopilotActive(testDir)).toBe(false);
        });
        it("should return true if file already missing", () => {
            const result = clearAutopilotState(testDir);
            expect(result).toBe(true);
        });
    });
    describe("transitionPhase", () => {
        it("should update phase field", () => {
            initAutopilot(testDir, "test");
            const state = transitionPhase(testDir, "planning");
            expect(state?.phase).toBe("planning");
        });
        it("should mark as inactive on complete", () => {
            initAutopilot(testDir, "test");
            const state = transitionPhase(testDir, "complete");
            expect(state?.active).toBe(false);
            expect(state?.completed_at).not.toBeNull();
        });
    });
    describe("phase updates", () => {
        it("should update expansion data", () => {
            initAutopilot(testDir, "test");
            updateExpansion(testDir, { analyst_complete: true });
            const state = readAutopilotState(testDir);
            expect(state?.expansion.analyst_complete).toBe(true);
        });
        it("should update execution data", () => {
            initAutopilot(testDir, "test");
            updateExecution(testDir, { tasks_completed: 5, tasks_total: 10 });
            const state = readAutopilotState(testDir);
            expect(state?.execution.tasks_completed).toBe(5);
        });
    });
});
describe('workflow profile state contract (#3487)', () => {
    let testDir;
    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), 'workflow-profile-state-'));
    });
    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
    });
    it('keeps legacy autopilot state readable without profile metadata', () => {
        const state = initAutopilot(testDir, 'legacy task', 'legacy-session');
        const persisted = readAutopilotState(testDir, 'legacy-session');
        expect(state).not.toBeNull();
        expect(persisted?.workflow).toBeUndefined();
        expect(persisted?.pipelineTracking).toBeUndefined();
    });
    it('leaves malformed named markers byte-identical without flock', () => {
        const sessionId = 'partial-named-no-flock';
        const state = initAutopilot(testDir, 'partial named task', sessionId);
        const partialNamedState = { ...state, workflowRunId: '' };
        writeAutopilotState(testDir, partialNamedState, sessionId);
        const statePath = join(testDir, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');
        const before = readFileSync(statePath);
        process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
        expect(updateAutopilotStateIfCurrent(testDir, partialNamedState, { active: false }, sessionId)).toBeNull();
        expect(readFileSync(statePath)).toEqual(before);
    });
    it('uses durable exact clear for a structurally valid named state without flock', () => {
        const sessionId = 'portable-named-clear';
        const state = initAutopilot(testDir, 'ship it', sessionId);
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
                activationBoundary: { transcriptPath: join(testDir, `${sessionId}.jsonl`), transcriptRoot: testDir, transcriptBasename: `${sessionId}.jsonl`, sessionId, byteOffset: 0, fileIdentity: identity },
                completionObservations: [],
            },
        });
        writeAutopilotState(testDir, state, sessionId);
        const persisted = readAutopilotState(testDir, sessionId);
        expect(validateNamedWorkflowStateStructure(persisted, sessionId)).not.toBeNull();
        process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
        expect(clearAutopilotState(testDir, sessionId, persisted)).toBe(true);
        expect(readAutopilotState(testDir, sessionId)).toBeNull();
    });
});
//# sourceMappingURL=state.test.js.map