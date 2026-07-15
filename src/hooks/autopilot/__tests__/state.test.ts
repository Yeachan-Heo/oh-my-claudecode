import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  readAutopilotState,
  clearAutopilotState,
  isAutopilotActive,
  initAutopilot,
  transitionPhase,
  updateAutopilotStateIfCurrent,
  updateExpansion,
  updateExecution,
  writeAutopilotState,
} from "../state.js";


describe("AutopilotState", () => {
  let testDir: string;

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
      expect(state!.active).toBe(true);
      expect(state!.phase).toBe("expansion");
      expect(state!.originalIdea).toBe("build a cli tool");
      expect(state!.expansion.analyst_complete).toBe(false);
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
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'workflow-profile-state-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });


  it('keeps legacy autopilot state readable without profile metadata', () => {
    const state = initAutopilot(testDir, 'legacy task', 'legacy-session');
    const persisted = readAutopilotState(testDir, 'legacy-session') as Record<string, unknown> | null;

    expect(state).not.toBeNull();
    expect(persisted?.workflow).toBeUndefined();
    expect(persisted?.pipelineTracking).toBeUndefined();
  });

  it('uses an exact-snapshot emergency pause for falsy named markers without flock', () => {
    const sessionId = 'partial-named-no-flock';
    const state = initAutopilot(testDir, 'partial named task', sessionId)!;
    const partialNamedState = {
      ...state,
      workflowRunId: '',
    } as typeof state;
    writeAutopilotState(testDir, partialNamedState, sessionId);
    process.env.OMC_TEST_FLOCK_AVAILABLE = '0';

    const paused = updateAutopilotStateIfCurrent(
      testDir,
      partialNamedState,
      { active: false },
      sessionId,
    );

    expect(paused).toMatchObject({ active: false, workflowRunId: '' });
    expect(readAutopilotState(testDir, sessionId)).toMatchObject({
      active: false,
      workflowRunId: '',
    });
    delete process.env.OMC_TEST_FLOCK_AVAILABLE;
  });
});
