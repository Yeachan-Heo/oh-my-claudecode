import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";

import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";

import {
  canResumeAutopilot,
  cancelAutopilot,
  resumeAutopilot,
} from "../cancel.js";
import { checkAutopilot } from "../enforcement.js";
import { createWorkflowDescriptor } from "../pipeline.js";
import {
  initAutopilot,
  readAutopilotState,
  writeAutopilotState,
} from "../state.js";
import {
  prepareNamedWorkflowAdvance,
  refreshNamedWorkflowBoundaryForCommit,
  validateNamedWorkflowState,
  validateNamedWorkflowStateStructure,
} from "../named-workflow-resume-validator.js";

describe("workflow descriptor integrity enforcement (#3487)", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "workflow-integrity-"));
    process.env.CLAUDE_CONFIG_DIR = join(testDir, "claude-config");
    mkdirSync(join(process.env.CLAUDE_CONFIG_DIR, "projects"), {
      recursive: true,
    });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.OMC_TEST_FLOCK_AVAILABLE;

  });

  it("returns a redacted integrity failure without mutating or advancing profile state", async () => {
    const sessionId = "workflow-session";
    initAutopilot(testDir, "ship the release", sessionId);
    const descriptor = createWorkflowDescriptor("release-flow", {
      version: 1,
      stages: ["ralplan", "execution"],
    })!;
    const base = readAutopilotState(testDir, sessionId)!;
    writeAutopilotState(testDir, { ...base, workflow: descriptor }, sessionId);
    const initialized = readAutopilotState(testDir, sessionId)!;
    writeAutopilotState(
      testDir,
      {
        ...initialized,
        workflow: { ...initialized.workflow!, profileHash: "0".repeat(64) },
      },
      sessionId,
    );
    const tampered = readAutopilotState(testDir, sessionId)!;
    const trackingBefore = tampered.pipelineTracking;

    const result = await checkAutopilot(sessionId, testDir);
    const persisted = readAutopilotState(testDir, sessionId)!;

    expect(result).toEqual({
      shouldBlock: false,
      message: "workflow_descriptor_integrity_failed",
      phase: "expansion",
    });
    expect(persisted).toEqual(tampered);
    expect(persisted.active).toBe(true);
    expect(persisted.pipelineTracking).toEqual(trackingBefore);
    expect(canResumeAutopilot(testDir, sessionId)).toEqual({
      canResume: false,
      resumePhase: "expansion",
      integrityFailed: true,
    });

    expect(cancelAutopilot(testDir, sessionId)).toMatchObject({
      success: false,
      message: "workflow_descriptor_integrity_failed",
    });
    expect(resumeAutopilot(testDir, sessionId)).toMatchObject({
      success: false,
      message: "workflow_descriptor_integrity_failed",
    });
  });

  it.each([
    ['workflow', false],
    ['workflowRunId', ''],
    ['pipelineTracking', null],
  ])('fails closed without mutation for a falsy own %s marker', async (marker, value) => {
    const sessionId = `falsy-marker-${marker}`;
    const base = initAutopilot(testDir, 'ship the release', sessionId)!;
    const partialNamed = { ...base, [marker]: value } as typeof base;
    writeAutopilotState(testDir, partialNamed, sessionId);
    const statePath = join(testDir, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');
    process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
    const before = readFileSync(statePath);

    await expect(checkAutopilot(sessionId, testDir)).resolves.toEqual({
      shouldBlock: false,
      message: 'workflow_descriptor_integrity_failed',
      phase: 'expansion',
    });

    expect(readFileSync(statePath)).toEqual(before);
  });

  it("dispatches a valid named state without legacy mutation", async () => {
    const sessionId = "named-reader-session";
    const base = initAutopilot(testDir, "ship the release", sessionId)!;
    const descriptor = createWorkflowDescriptor("release-flow", {
      version: 1,
      stages: ["ralplan", "execution"],
    })!;
    const transcriptRoot = join(testDir, "claude-config", "projects");
    const transcriptPath = join(transcriptRoot, `${sessionId}.jsonl`);
    writeFileSync(transcriptPath, "");
    const stat = statSync(transcriptPath);
    const identity = {
      device: stat.dev,
      inode: stat.ino,
      size: 0,
      mtimeNs: "0",
      ctimeNs: "0",
      contentSha256: createHash("sha256").update("").digest("hex"),
    };
    const boundary = {
      transcriptPath,
      transcriptRoot,
      transcriptBasename: `${sessionId}.jsonl`,
      sessionId,
      byteOffset: 0,
      fileIdentity: identity,
    };
    const namedState = {
      ...base,
      phase: "ralplan" as const,
      prompt: "ship the release",
      workflow: descriptor,
      workflowRunId: "11111111-1111-4111-8111-111111111111",
      pipelineTracking: {
        stages: [
          {
            id: "ralplan" as const,
            status: "active" as const,
            iterations: 0,
            startedAt: new Date().toISOString(),
          },
          {
            id: "execution" as const,
            status: "pending" as const,
            iterations: 0,
          },
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
    expect(result).toMatchObject({ shouldBlock: true, phase: "ralplan" });
    expect(result?.message).toContain(
      "## PIPELINE STAGE: RALPLAN (Consensus Planning)",
    );
    expect(readAutopilotState(testDir, sessionId)).toEqual(before);

    const malformed = {
      ...before,
      pipeline: before.pipelineTracking,
    } as typeof before & { pipeline: unknown };
    delete (malformed as Partial<typeof before>).pipelineTracking;
    writeAutopilotState(testDir, malformed, sessionId);
    await expect(checkAutopilot(sessionId, testDir)).resolves.toEqual({
      shouldBlock: false,
      message: "workflow_descriptor_integrity_failed",
      phase: "ralplan",
    });

    const missingDescriptor = structuredClone(before);
    delete (missingDescriptor as Partial<typeof before>).workflow;
    writeAutopilotState(testDir, missingDescriptor, sessionId);
    await expect(checkAutopilot(sessionId, testDir)).resolves.toEqual({
      shouldBlock: false,
      message: "workflow_descriptor_integrity_failed",
      phase: "ralplan",
    });

    const traversal = structuredClone(before);
    traversal.pipelineTracking!.activationBoundary!.transcriptPath = join(
      transcriptRoot,
      "..",
      "outside",
      `${sessionId}.jsonl`,
    );
    writeAutopilotState(testDir, traversal, sessionId);
    await expect(checkAutopilot(sessionId, testDir)).resolves.toMatchObject({
      shouldBlock: false,
      message: "workflow_descriptor_integrity_failed",
    });

    const wrongBasename = structuredClone(before);
    wrongBasename.pipelineTracking!.activationBoundary!.transcriptPath = join(
      transcriptRoot,
      "other.jsonl",
    );
    writeFileSync(
      wrongBasename.pipelineTracking!.activationBoundary!.transcriptPath,
      "",
    );
    writeAutopilotState(testDir, wrongBasename, sessionId);
    await expect(checkAutopilot(sessionId, testDir)).resolves.toMatchObject({
      shouldBlock: false,
      message: "workflow_descriptor_integrity_failed",
    });
  });

  it("does not advance or dispatch a signed named workflow on an unsupported runtime", async () => {
    const sessionId = "named-unsupported-runtime";
    const base = initAutopilot(testDir, "ship the release", sessionId)!;
    const descriptor = createWorkflowDescriptor("release-flow", {
      version: 1,
      stages: ["ralplan", "execution"],
    })!;
    const transcriptRoot = join(testDir, "claude-config", "projects");
    const transcriptPath = join(transcriptRoot, `${sessionId}.jsonl`);
    writeFileSync(transcriptPath, "");
    const stat = statSync(transcriptPath);
    const identity = {
      device: stat.dev,
      inode: stat.ino,
      size: 0,
      mtimeNs: "0",
      ctimeNs: "0",
      contentSha256: createHash("sha256").update("").digest("hex"),
    };
    writeAutopilotState(
      testDir,
      {
        ...base,
        phase: "ralplan",
        prompt: "ship the release",
        workflow: descriptor,
        workflowRunId: "11111111-1111-4111-8111-111111111111",
        pipelineTracking: {
          stages: [
            { id: "ralplan", status: "active", iterations: 0, startedAt: new Date().toISOString() },
            { id: "execution", status: "pending", iterations: 0 },
          ],
          currentStageIndex: 0,
          trackingRevision: 0,
          activationBoundary: {
            transcriptPath,
            transcriptRoot,
            transcriptBasename: `${sessionId}.jsonl`,
            sessionId,
            byteOffset: 0,
            fileIdentity: identity,
          },
          completionObservations: [],
        },
      },
      sessionId,
    );

    const signal = JSON.stringify({
      sessionId,
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Signal: PIPELINE_RALPLAN_COMPLETE" }],
      },
    });
    writeFileSync(transcriptPath, `${signal}\n`);
    const statePath = join(testDir, ".omc", "state", "sessions", sessionId, "autopilot-state.json");
    const validState = readAutopilotState(testDir, sessionId)!;
    const before = readFileSync(statePath);
    expect(validateNamedWorkflowStateStructure(validState, sessionId)).not.toBeNull();
    process.env.OMC_TEST_FLOCK_AVAILABLE = "0";

    const result = await checkAutopilot(sessionId, testDir);

    expect(result).toEqual({
      shouldBlock: false,
      message:
        "[AUTOPILOT NAMED WORKFLOW UNSUPPORTED] Named workflow enforcement requires Linux with flock. State was left unchanged; use /cancel to safely stop this workflow.",
      phase: "ralplan",
    });
    expect(result?.message).not.toContain("PIPELINE STAGE");
    expect(readFileSync(statePath)).toEqual(before);

    const nonBooleanActive = readAutopilotState(testDir, sessionId)!;
    nonBooleanActive.active = 0 as never;
    writeAutopilotState(testDir, nonBooleanActive, sessionId);
    await expect(checkAutopilot(sessionId, testDir)).resolves.toEqual({
      shouldBlock: false,
      message: "workflow_descriptor_integrity_failed",
      phase: "ralplan",
    });

    const sizeMismatch = structuredClone(validState);
    sizeMismatch.pipelineTracking!.activationBoundary!.fileIdentity.size = 1;
    writeAutopilotState(testDir, sizeMismatch, sessionId);
    await expect(checkAutopilot(sessionId, testDir)).resolves.toEqual({
      shouldBlock: false,
      message: "workflow_descriptor_integrity_failed",
      phase: "ralplan",
    });
  });

  it("authenticates an exact named completion signal and advances without legacy state", async () => {
    const sessionId = "named-advance-session";
    const base = initAutopilot(testDir, "ship the release", sessionId)!;
    const descriptor = createWorkflowDescriptor("release-flow", {
      version: 1,
      stages: ["ralplan", "execution"],
    })!;
    const transcriptRoot = join(testDir, "claude-config", "projects");
    const transcriptPath = join(transcriptRoot, `${sessionId}.jsonl`);
    writeFileSync(transcriptPath, "");
    const stat = statSync(transcriptPath);
    const identity = {
      device: stat.dev,
      inode: stat.ino,
      size: 0,
      mtimeNs: "0",
      ctimeNs: "0",
      contentSha256: createHash("sha256").update("").digest("hex"),
    };
    writeAutopilotState(
      testDir,
      {
        ...base,
        phase: "ralplan",
        prompt: "ship the release",
        workflow: descriptor,
        workflowRunId: "11111111-1111-4111-8111-111111111111",
        pipelineTracking: {
          stages: [
            {
              id: "ralplan",
              status: "active",
              iterations: 0,
              startedAt: new Date().toISOString(),
            },
            { id: "execution", status: "pending", iterations: 0 },
          ],
          currentStageIndex: 0,
          trackingRevision: 0,
          activationBoundary: {
            transcriptPath,
            transcriptRoot,
            transcriptBasename: `${sessionId}.jsonl`,
            sessionId,
            byteOffset: 0,
            fileIdentity: identity,
          },
          completionObservations: [],
        },
      },
      sessionId,
    );
    const unadvanced = readAutopilotState(testDir, sessionId)!;
    const signal = JSON.stringify({
      sessionId,
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "validate stage completion" },
          { type: "redacted_thinking", data: "redacted" },
          { type: "text", text: "Signal: PIPELINE_RALPLAN_COMPLETE" },
        ],
      },
    });
    const unrelated = JSON.stringify({
      sessionId,
      type: "user",
      message: { role: "user", content: "unrelated" },
    });
    writeFileSync(transcriptPath, `${signal}\n${unrelated}\n`);


    const result = await checkAutopilot(sessionId, testDir);
    const persisted = readAutopilotState(testDir, sessionId)!;

    expect(result).toMatchObject({ shouldBlock: true, phase: "execution" });
    expect(result?.message).toContain("## PIPELINE STAGE: EXECUTION");
    expect(persisted.phase).toBe("execution");
    expect(persisted.pipelineTracking).toMatchObject({
      currentStageIndex: 1,
      trackingRevision: 1,
    });
    expect(persisted.pipelineTracking?.completionObservations).toHaveLength(1);
    expect(persisted.expansion).toEqual(base.expansion);
    expect(persisted.planning).toEqual(base.planning);

    const terminalSignal = JSON.stringify({
      sessionId,
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Signal: PIPELINE_EXECUTION_COMPLETE" },
        ],
      },
    });
    writeFileSync(
      transcriptPath,
      `${signal}\n${unrelated}\n${terminalSignal}\n`,
    );

    const terminalResult = await checkAutopilot(sessionId, testDir);
    const terminal = readAutopilotState(testDir, sessionId)!;
    expect(terminalResult).toMatchObject({
      shouldBlock: false,
      phase: "complete",
    });
    expect(terminal).toMatchObject({ active: false, phase: "complete" });
    expect(terminal.pipelineTracking).toMatchObject({
      currentStageIndex: 2,
      trackingRevision: 2,
    });
    expect(
      terminal.pipelineTracking?.stages.every(
        (stage) => stage.status === "complete",
      ),
    ).toBe(true);
    expect(validateNamedWorkflowState(terminal, sessionId)).not.toBeNull();

    const activeTerminal = structuredClone(terminal);
    activeTerminal.active = true;
    expect(validateNamedWorkflowStateStructure(activeTerminal, sessionId)).toBeNull();

    const observationSizeMismatch = structuredClone(terminal);
    observationSizeMismatch.pipelineTracking!.completionObservations![0].activationBoundary.fileIdentity.size += 1;
    expect(
      validateNamedWorkflowStateStructure(observationSizeMismatch, sessionId),
    ).toBeNull();
    expect(canResumeAutopilot(testDir, sessionId)).toEqual({
      canResume: false,
      state: terminal,
      resumePhase: "complete",
    });
    expect(resumeAutopilot(testDir, sessionId)).toMatchObject({
      success: false,
      message: "No autopilot session available to resume",
    });

    const truncatedTerminal = structuredClone(terminal);
    truncatedTerminal.pipelineTracking!.currentStageIndex = 1;
    truncatedTerminal.pipelineTracking!.trackingRevision = 1;
    truncatedTerminal.pipelineTracking!.completionObservations =
      truncatedTerminal.pipelineTracking!.completionObservations!.slice(0, 1);
    truncatedTerminal.pipelineTracking!.activationBoundary = structuredClone(
      terminal.pipelineTracking!.completionObservations![1].activationBoundary,
    );
    expect(validateNamedWorkflowState(truncatedTerminal, sessionId)).toBeNull();

    const malformedTerminal = structuredClone(terminal);
    malformedTerminal.pipelineTracking!.activationBoundary = structuredClone(
      malformedTerminal.pipelineTracking!.completionObservations![0]
        .activationBoundary,
    );
    writeAutopilotState(testDir, malformedTerminal, sessionId);
    expect(
      validateNamedWorkflowState(
        readAutopilotState(testDir, sessionId)!,
        sessionId,
      ),
    ).toBeNull();
    expect(canResumeAutopilot(testDir, sessionId)).toMatchObject({
      canResume: false,
      resumePhase: "complete",
      integrityFailed: true,
    });

    writeAutopilotState(testDir, unadvanced, sessionId);
    const malformedThinkingSignal = JSON.stringify({
      sessionId,
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: 1 },
          { type: "text", text: "Signal: PIPELINE_RALPLAN_COMPLETE" },
        ],
      },
    });

    for (const suffix of [
      `${signal}\n{"truncated":\n`,
      `{"truncated":\n${signal}\n`,
      `${signal}\n\n\n`,
      `\n${signal}\n`,
      `${malformedThinkingSignal}\n`,
    ]) {
      writeAutopilotState(testDir, unadvanced, sessionId);
      writeFileSync(transcriptPath, suffix);

      const rejected = await checkAutopilot(sessionId, testDir);
      const unchanged = readAutopilotState(testDir, sessionId)!;
      expect(rejected).toMatchObject({ shouldBlock: true, phase: "ralplan" });
      expect(unchanged.phase).toBe("ralplan");
      expect(unchanged.pipelineTracking).toMatchObject({
        currentStageIndex: 0,
        trackingRevision: 0,
      });
    }

    writeAutopilotState(testDir, unadvanced, sessionId);
    writeFileSync(transcriptPath, `${signal}\n`);
    const prepared = prepareNamedWorkflowAdvance(unadvanced, sessionId);
    expect(prepared).not.toBeNull();

    const appendedNextStageSignal = JSON.stringify({
      sessionId,
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Signal: PIPELINE_EXECUTION_COMPLETE" }],
      },
    });
    writeFileSync(transcriptPath, `${signal}\n${appendedNextStageSignal}\n`);

    expect(refreshNamedWorkflowBoundaryForCommit(prepared!)).toBe(false);
    expect(readAutopilotState(testDir, sessionId)).toEqual(unadvanced);
  });
});
