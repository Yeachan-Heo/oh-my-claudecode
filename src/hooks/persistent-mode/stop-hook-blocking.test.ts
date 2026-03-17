import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import {
  createHookOutput,
  checkPersistentModes,
  type PersistentModeResult,
} from "./index.js";
import { activateUltrawork, deactivateUltrawork } from "../ultrawork/index.js";

function writeTranscriptWithContext(filePath: string, contextWindow: number, inputTokens: number): void {
  writeFileSync(
    filePath,
    `${JSON.stringify({
      usage: { context_window: contextWindow, input_tokens: inputTokens },
      context_window: contextWindow,
      input_tokens: inputTokens,
    })}\n`
  );
}

function writeSubagentTrackingState(
  tempDir: string,
  agents: Array<Record<string, unknown>>,
): void {
  const stateDir = join(tempDir, ".omc", "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "subagent-tracking.json"),
    JSON.stringify(
      {
        agents,
        total_spawned: agents.length,
        total_completed: agents.filter((agent) => agent.status === "completed").length,
        total_failed: agents.filter((agent) => agent.status === "failed").length,
        last_updated: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

describe("Stop Hook Blocking Contract", () => {
  describe("createHookOutput", () => {
    it("returns continue: false when shouldBlock is true", () => {
      const result: PersistentModeResult = {
        shouldBlock: true,
        message: "Continue working",
        mode: "ralph",
      };
      const output = createHookOutput(result);
      expect(output.continue).toBe(false);
      expect(output.message).toBe("Continue working");
    });

    it("returns continue: true when shouldBlock is false", () => {
      const result: PersistentModeResult = {
        shouldBlock: false,
        message: "",
        mode: "none",
      };
      const output = createHookOutput(result);
      expect(output.continue).toBe(true);
    });

    it("returns continue: true when shouldBlock is false with message", () => {
      const result: PersistentModeResult = {
        shouldBlock: false,
        message: "[RALPH LOOP COMPLETE] Done!",
        mode: "none",
      };
      const output = createHookOutput(result);
      expect(output.continue).toBe(true);
      expect(output.message).toBe("[RALPH LOOP COMPLETE] Done!");
    });

    it("returns continue: false for ultrawork mode blocking", () => {
      const result: PersistentModeResult = {
        shouldBlock: true,
        message: "[ULTRAWORK] Mode active.",
        mode: "ultrawork",
        metadata: { reinforcementCount: 3 },
      };
      const output = createHookOutput(result);
      expect(output.continue).toBe(false);
      expect(output.message).toContain("ULTRAWORK");
    });

    it("returns continue: false for autopilot mode blocking", () => {
      const result: PersistentModeResult = {
        shouldBlock: true,
        message: "[AUTOPILOT] Continue working",
        mode: "autopilot",
        metadata: { phase: "execution" },
      };
      const output = createHookOutput(result);
      expect(output.continue).toBe(false);
    });

    it("returns undefined message when result message is empty", () => {
      const result: PersistentModeResult = {
        shouldBlock: false,
        message: "",
        mode: "none",
      };
      const output = createHookOutput(result);
      expect(output.message).toBeUndefined();
    });
  });

  describe("checkPersistentModes -> createHookOutput integration", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "stop-hook-blocking-test-"));
      execSync("git init", { cwd: tempDir });
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("blocks stop for active ultrawork (shouldBlock: true -> continue: false)", async () => {
      const sessionId = "test-session-block";
      activateUltrawork("Fix the bug", sessionId, tempDir);

      const result = await checkPersistentModes(sessionId, tempDir);
      expect(result.shouldBlock).toBe(true);

      const output = createHookOutput(result);
      expect(output.continue).toBe(false);
      expect(output.message).toBeDefined();
    });

    it("allows stop for deactivated ultrawork (shouldBlock: false -> continue: true)", async () => {
      const sessionId = "test-session-allow";
      activateUltrawork("Task complete", sessionId, tempDir);
      deactivateUltrawork(tempDir, sessionId);

      const result = await checkPersistentModes(sessionId, tempDir);
      expect(result.shouldBlock).toBe(false);

      const output = createHookOutput(result);
      expect(output.continue).toBe(true);
    });

    it("allows stop when no active modes (shouldBlock: false -> continue: true)", async () => {
      const result = await checkPersistentModes("any-session", tempDir);
      expect(result.shouldBlock).toBe(false);

      const output = createHookOutput(result);
      expect(output.continue).toBe(true);
    });

    it("allows stop for context limit even with active mode", async () => {
      const sessionId = "test-context-limit";
      activateUltrawork("Important task", sessionId, tempDir);

      const stopContext = {
        stop_reason: "context_limit",
      };

      const result = await checkPersistentModes(sessionId, tempDir, stopContext);
      expect(result.shouldBlock).toBe(false);

      const output = createHookOutput(result);
      expect(output.continue).toBe(true);
    });

    it("allows stop for user abort even with active mode", async () => {
      const sessionId = "test-user-abort";
      activateUltrawork("Important task", sessionId, tempDir);

      const stopContext = {
        user_requested: true,
      };

      const result = await checkPersistentModes(sessionId, tempDir, stopContext);
      expect(result.shouldBlock).toBe(false);

      const output = createHookOutput(result);
      expect(output.continue).toBe(true);
    });

    it("allows stop for rate limit even with active mode", async () => {
      const sessionId = "test-rate-limit";
      activateUltrawork("Important task", sessionId, tempDir);

      const stopContext = {
        stop_reason: "rate_limit",
      };

      const result = await checkPersistentModes(sessionId, tempDir, stopContext);
      expect(result.shouldBlock).toBe(false);

      const output = createHookOutput(result);
      expect(output.continue).toBe(true);
    });

    it("allows stop for critical transcript context even with active autopilot", async () => {
      const sessionId = "test-autopilot-critical-context";
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      const transcriptPath = join(tempDir, "transcript.jsonl");
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "autopilot-state.json"),
        JSON.stringify({
          active: true,
          phase: "execution",
          session_id: sessionId,
          iteration: 2,
          max_iterations: 20,
          reinforcement_count: 0,
          last_checked_at: new Date().toISOString(),
          started_at: new Date().toISOString(),
        })
      );
      writeTranscriptWithContext(transcriptPath, 1000, 960);

      const result = await checkPersistentModes(sessionId, tempDir, {
        transcript_path: transcriptPath,
        stop_reason: "end_turn",
      });
      expect(result.shouldBlock).toBe(false);
      expect(result.mode).toBe("none");

      const output = createHookOutput(result);
      expect(output.continue).toBe(true);
      expect(output.message).toBeUndefined();
    });

    it("blocks stop for active ralph loop", async () => {
      const sessionId = "test-ralph-block";
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "ralph-state.json"),
        JSON.stringify({
          active: true,
          iteration: 1,
          max_iterations: 50,
          session_id: sessionId,
          started_at: new Date().toISOString(),
          last_checked_at: new Date().toISOString(),
          prompt: "Test ralph task",
        })
      );

      const result = await checkPersistentModes(sessionId, tempDir);
      expect(result.shouldBlock).toBe(true);
      expect(result.mode).toBe("ralph");

      const output = createHookOutput(result);
      expect(output.continue).toBe(false);
      expect(output.message).toContain("RALPH");
    });

    it("blocks stop for active skill state", async () => {
      const sessionId = "test-skill-block";
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "skill-active-state.json"),
        JSON.stringify({
          active: true,
          skill_name: "ralplan",
          session_id: sessionId,
          started_at: new Date().toISOString(),
          last_checked_at: new Date().toISOString(),
          reinforcement_count: 0,
          max_reinforcements: 5,
          stale_ttl_ms: 15 * 60 * 1000,
        })
      );

      const result = await checkPersistentModes(sessionId, tempDir);
      expect(result.shouldBlock).toBe(true);

      const output = createHookOutput(result);
      expect(output.continue).toBe(false);
      expect(output.message).toContain("ralplan");
    });
  });

  describe("persistent-mode.mjs script blocking contract", () => {
    let tempDir: string;
    const scriptPath = join(process.cwd(), "scripts", "persistent-mode.mjs");

    function runScript(input: Record<string, unknown>): Record<string, unknown> {
      try {
        const result = execSync(`node "${scriptPath}"`, {
          encoding: "utf-8",
          timeout: 5000,
          input: JSON.stringify(input),
          env: { ...process.env, NODE_ENV: "test" },
        });
        const lines = result.trim().split("\n");
        return JSON.parse(lines[lines.length - 1]);
      } catch (error: unknown) {
        const execError = error as { stdout?: string };
        if (execError.stdout) {
          const lines = execError.stdout.trim().split("\n");
          return JSON.parse(lines[lines.length - 1]);
        }
        throw error;
      }
    }

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "stop-hook-mjs-test-"));
      execSync("git init", { cwd: tempDir });
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("returns decision: block when ralph is active", () => {
      const sessionId = "ralph-mjs-test";
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "ralph-state.json"),
        JSON.stringify({
          active: true,
          iteration: 1,
          max_iterations: 50,
          session_id: sessionId,
          started_at: new Date().toISOString(),
          last_checked_at: new Date().toISOString(),
          prompt: "Test task",
        })
      );

      const output = runScript({ directory: tempDir, sessionId });
      expect(output.decision).toBe("block");
    });

    it("returns decision: block when ultrawork is active", () => {
      const sessionId = "ultrawork-mjs-test";
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "ultrawork-state.json"),
        JSON.stringify({
          active: true,
          started_at: new Date().toISOString(),
          original_prompt: "Test task",
          session_id: sessionId,
          reinforcement_count: 0,
          last_checked_at: new Date().toISOString(),
        })
      );

      const output = runScript({ directory: tempDir, sessionId });
      expect(output.decision).toBe("block");
    });

    it("returns continue: true for context limit stop", () => {
      const sessionId = "ctx-limit-mjs";
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "ralph-state.json"),
        JSON.stringify({
          active: true,
          iteration: 1,
          max_iterations: 50,
          session_id: sessionId,
          started_at: new Date().toISOString(),
          last_checked_at: new Date().toISOString(),
        })
      );

      const output = runScript({
        directory: tempDir,
        sessionId,
        stop_reason: "context_limit",
      });
      expect(output.continue).toBe(true);
    });

    it("returns continue: true for critical transcript context when autopilot is active", () => {
      const sessionId = "autopilot-critical-context-mjs";
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      const transcriptPath = join(tempDir, "transcript.jsonl");
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "autopilot-state.json"),
        JSON.stringify({
          active: true,
          phase: "execution",
          session_id: sessionId,
          reinforcement_count: 0,
          last_checked_at: new Date().toISOString(),
          started_at: new Date().toISOString(),
        })
      );
      writeTranscriptWithContext(transcriptPath, 1000, 960);

      const output = runScript({
        directory: tempDir,
        sessionId,
        transcript_path: transcriptPath,
        stop_reason: "end_turn",
      });
      expect(output.continue).toBe(true);
      expect(output.decision).toBeUndefined();
    });

    it("returns continue: true for user abort", () => {
      const sessionId = "abort-mjs";
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "ralph-state.json"),
        JSON.stringify({
          active: true,
          iteration: 1,
          max_iterations: 50,
          session_id: sessionId,
          started_at: new Date().toISOString(),
          last_checked_at: new Date().toISOString(),
        })
      );

      const output = runScript({
        directory: tempDir,
        sessionId,
        user_requested: true,
      });
      expect(output.continue).toBe(true);
    });

    it("returns continue: true for authentication error stop", () => {
      const sessionId = "auth-error-mjs";
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "ralph-state.json"),
        JSON.stringify({
          active: true,
          iteration: 1,
          max_iterations: 50,
          session_id: sessionId,
          started_at: new Date().toISOString(),
          last_checked_at: new Date().toISOString(),
        })
      );

      const output = runScript({
        directory: tempDir,
        sessionId,
        stop_reason: "oauth_expired",
      });
      expect(output.continue).toBe(true);
    });

    it("returns continue: true when no modes are active", () => {
      const output = runScript({ directory: tempDir, sessionId: "no-modes" });
      expect(output.continue).toBe(true);
    });

    it("fails open for missing/unknown Team phase in script", () => {
      const sessionId = "team-phase-mjs";
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      mkdirSync(sessionDir, { recursive: true });

      writeFileSync(
        join(sessionDir, "team-state.json"),
        JSON.stringify({
          active: true,
          session_id: sessionId,
          last_checked_at: new Date().toISOString(),
          started_at: new Date().toISOString(),
        })
      );
      const missingPhaseOutput = runScript({ directory: tempDir, sessionId });
      expect(missingPhaseOutput.continue).toBe(true);

      writeFileSync(
        join(sessionDir, "team-state.json"),
        JSON.stringify({
          active: true,
          session_id: sessionId,
          current_phase: "phase-does-not-exist",
          last_checked_at: new Date().toISOString(),
          started_at: new Date().toISOString(),
        })
      );
      const unknownPhaseOutput = runScript({ directory: tempDir, sessionId });
      expect(unknownPhaseOutput.continue).toBe(true);
    });

    it("applies Team circuit breaker after max reinforcements in script", () => {
      const sessionId = "team-breaker-mjs";
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "team-state.json"),
        JSON.stringify({
          active: true,
          session_id: sessionId,
          current_phase: "team-exec",
          reinforcement_count: 20,
          last_checked_at: new Date().toISOString(),
          started_at: new Date().toISOString(),
        })
      );

      const output = runScript({ directory: tempDir, sessionId });
      expect(output.continue).toBe(true);
    });

    it("returns continue: true for terminal autopilot state", () => {
      const sessionId = "autopilot-complete";
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "autopilot-state.json"),
        JSON.stringify({
          active: true,
          phase: "complete",
          session_id: sessionId,
          reinforcement_count: 0,
          last_checked_at: new Date().toISOString(),
        })
      );

      const output = runScript({ directory: tempDir, sessionId });
      expect(output.continue).toBe(true);
    });
  });

  describe("persistent-mode.cjs script blocking contract", () => {
    let tempDir: string;
    const scriptPath = join(process.cwd(), "scripts", "persistent-mode.cjs");

    function runScript(input: Record<string, unknown>): Record<string, unknown> {
      try {
        const result = execSync(`node "${scriptPath}"`, {
          encoding: "utf-8",
          timeout: 5000,
          input: JSON.stringify(input),
          env: { ...process.env, NODE_ENV: "test" },
        });
        const lines = result.trim().split("\n");
        return JSON.parse(lines[lines.length - 1]);
      } catch (error: unknown) {
        const execError = error as { stdout?: string };
        if (execError.stdout) {
          const lines = execError.stdout.trim().split("\n");
          return JSON.parse(lines[lines.length - 1]);
        }
        throw error;
      }
    }

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "stop-hook-cjs-test-"));
      execSync("git init", { cwd: tempDir });
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("returns continue: true for authentication error stop", () => {
      const sessionId = "auth-error-cjs";
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "ralph-state.json"),
        JSON.stringify({
          active: true,
          iteration: 1,
          max_iterations: 50,
          session_id: sessionId,
          started_at: new Date().toISOString(),
          last_checked_at: new Date().toISOString(),
        })
      );

      const output = runScript({
        directory: tempDir,
        sessionId,
        stop_reason: "oauth_expired",
      });
      expect(output.continue).toBe(true);
    });

    it("returns continue: true when skill state is active but delegated subagents are still running", () => {
      const sessionId = "skill-active-subagents-cjs";
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "skill-active-state.json"),
        JSON.stringify({
          active: true,
          skill_name: "ralplan",
          session_id: sessionId,
          started_at: new Date().toISOString(),
          last_checked_at: new Date().toISOString(),
          reinforcement_count: 0,
          max_reinforcements: 5,
          stale_ttl_ms: 15 * 60 * 1000,
        }),
      );
      writeSubagentTrackingState(tempDir, [
        {
          agent_id: "agent-cjs-1",
          agent_type: "explore",
          started_at: new Date().toISOString(),
          parent_mode: "none",
          status: "running",
        },
      ]);

      const output = runScript({ directory: tempDir, sessionId });
      expect(output.continue).toBe(true);
      expect(output.decision).toBeUndefined();

      const persisted = JSON.parse(
        readFileSync(join(sessionDir, "skill-active-state.json"), "utf-8"),
      ) as { reinforcement_count?: number };
      expect(persisted.reinforcement_count).toBe(0);
    });

    it("returns continue: true for critical transcript context when autopilot is active", () => {
      const sessionId = "autopilot-critical-context-cjs";
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      const transcriptPath = join(tempDir, "transcript.jsonl");
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "autopilot-state.json"),
        JSON.stringify({
          active: true,
          phase: "execution",
          session_id: sessionId,
          reinforcement_count: 0,
          last_checked_at: new Date().toISOString(),
          started_at: new Date().toISOString(),
        })
      );
      writeTranscriptWithContext(transcriptPath, 1000, 960);

      const output = runScript({
        directory: tempDir,
        sessionId,
        transcript_path: transcriptPath,
        stop_reason: "end_turn",
      });
      expect(output.continue).toBe(true);
      expect(output.decision).toBeUndefined();
    });


    it("omits cancel guidance for legacy autopilot state without a session id in cjs script", () => {
      const stateDir = join(tempDir, ".omc", "state");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, "autopilot-state.json"),
        JSON.stringify({
          active: true,
          phase: "execution",
          reinforcement_count: 0,
          last_checked_at: new Date().toISOString(),
          started_at: new Date().toISOString(),
        })
      );

      const output = runScript({
        directory: tempDir,
      });

      expect(output.decision).toBe("block");
      expect(output.reason).toContain("AUTOPILOT");
      expect(output.reason).not.toContain('/oh-my-claudecode:cancel');
    });

    it("fails open for unknown Team phase in cjs script", () => {
      const sessionId = "team-phase-cjs";
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "team-state.json"),
        JSON.stringify({
          active: true,
          session_id: sessionId,
          current_phase: "totally-unknown",
          last_checked_at: new Date().toISOString(),
          started_at: new Date().toISOString(),
        })
      );

      const output = runScript({
        directory: tempDir,
        sessionId,
      });
      expect(output.continue).toBe(true);
    });

    it("deactivates ultrawork state when max reinforcements reached", () => {
      const sessionId = "ulw-max-reinforce-cjs";
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      mkdirSync(sessionDir, { recursive: true });
      const statePath = join(sessionDir, "ultrawork-state.json");
      writeFileSync(
        statePath,
        JSON.stringify({
          active: true,
          session_id: sessionId,
          reinforcement_count: 51,
          max_reinforcements: 50,
          started_at: new Date().toISOString(),
          last_checked_at: new Date().toISOString(),
          project_path: tempDir,
        })
      );

      const output = runScript({
        directory: tempDir,
        sessionId,
      });
      // Should allow stop
      expect(output.continue).toBe(true);

      // State should be deactivated
      const updatedState = JSON.parse(readFileSync(statePath, "utf-8"));
      expect(updatedState.active).toBe(false);
      expect(updatedState.deactivated_reason).toBe("max_reinforcements_reached");
    });

    it("applies Team circuit breaker in cjs script", () => {
      const sessionId = "team-breaker-cjs";
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "team-state.json"),
        JSON.stringify({
          active: true,
          session_id: sessionId,
          current_phase: "team-exec",
          reinforcement_count: 20,
          last_checked_at: new Date().toISOString(),
          started_at: new Date().toISOString(),
        })
      );
      // Priority 2.5 uses a separate stop-breaker file for circuit breaking
      writeFileSync(
        join(sessionDir, "team-pipeline-stop-breaker.json"),
        JSON.stringify({
          count: 21, // exceeds TEAM_PIPELINE_STOP_BLOCKER_MAX (20)
          updated_at: new Date().toISOString(),
        })
      );

      const output = runScript({
        directory: tempDir,
        sessionId,
      });
      expect(output.continue).toBe(true);
    });
  });
});
