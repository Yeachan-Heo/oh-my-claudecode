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
import { getOmcRoot } from "../../lib/worktree-paths.js";

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

function writePendingTodo(tempDir: string, content: string): void {
  mkdirSync(join(tempDir, ".claude"), { recursive: true });
  writeFileSync(
    join(tempDir, ".claude", "todos.json"),
    JSON.stringify({
      todos: [
        {
          content,
          status: "pending",
          priority: "high",
        },
      ],
    }),
  );
}

function writeLegacyModeState(
  tempDir: string,
  fileName: string,
  state: Record<string, unknown>,
): void {
  const stateDir = join(tempDir, ".omc", "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, fileName), JSON.stringify(state, null, 2));
}

function resolveCentralizedStateDir(directory: string, customStateDir: string): string {
  const previous = process.env.OMC_STATE_DIR;
  process.env.OMC_STATE_DIR = customStateDir;
  try {
    return join(getOmcRoot(directory), "state");
  } finally {
    if (previous === undefined) {
      delete process.env.OMC_STATE_DIR;
    } else {
      process.env.OMC_STATE_DIR = previous;
    }
  }
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


    it("ignores ultrawork states that are still awaiting skill confirmation", async () => {
      const sessionId = "ultrawork-awaiting-confirmation";
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "ultrawork-state.json"),
        JSON.stringify({
          active: true,
          awaiting_confirmation: true,
          started_at: new Date().toISOString(),
          original_prompt: "Test task",
          session_id: sessionId,
          reinforcement_count: 0,
          last_checked_at: new Date().toISOString(),
        })
      );

      const result = await checkPersistentModes(sessionId, tempDir);
      expect(result.shouldBlock).toBe(false);
      expect(result.mode).toBe("none");
    });


    it("stale awaiting_confirmation does not suppress ultrawork enforcement", async () => {
      const sessionId = "ultrawork-stale-awaiting-confirmation";
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      mkdirSync(sessionDir, { recursive: true });
      mkdirSync(join(tempDir, '.claude'), { recursive: true });
      writeFileSync(
        join(tempDir, '.claude', 'todos.json'),
        JSON.stringify({
          todos: [
            {
              content: 'resume the queued task',
              status: 'pending',
              priority: 'high'
            }
          ]
        }),
      );
      writeFileSync(
        join(sessionDir, "ultrawork-state.json"),
        JSON.stringify({
          active: true,
          awaiting_confirmation: true,
          awaiting_confirmation_set_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
          started_at: new Date().toISOString(),
          original_prompt: "Test task",
          session_id: sessionId,
          reinforcement_count: 0,
          last_checked_at: new Date().toISOString(),
        })
      );

      const result = await checkPersistentModes(sessionId, tempDir);
      expect(result.shouldBlock).toBe(true);
      expect(result.mode).toBe("ultrawork");
    });


    it("does not use fresh last_checked_at as fallback for stale awaiting_confirmation", async () => {
      const sessionId = "ultrawork-fresh-last-checked-still-stale-confirmation";
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      mkdirSync(sessionDir, { recursive: true });
      mkdirSync(join(tempDir, '.claude'), { recursive: true });
      writeFileSync(
        join(tempDir, '.claude', 'todos.json'),
        JSON.stringify({
          todos: [
            {
              content: 'resume the queued task',
              status: 'pending',
              priority: 'high'
            }
          ]
        }),
      );
      writeFileSync(
        join(sessionDir, "ultrawork-state.json"),
        JSON.stringify({
          active: true,
          awaiting_confirmation: true,
          started_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
          original_prompt: "Test task",
          session_id: sessionId,
          reinforcement_count: 0,
          last_checked_at: new Date().toISOString(),
        })
      );

      const result = await checkPersistentModes(sessionId, tempDir);
      expect(result.shouldBlock).toBe(true);
      expect(result.mode).toBe("ultrawork");
    });

    it("blocks stop for active ultrawork while incomplete work remains (shouldBlock: true -> continue: false)", async () => {
      const sessionId = "test-session-block";
      activateUltrawork("Fix the bug", sessionId, tempDir);
      mkdirSync(join(tempDir, '.claude'), { recursive: true });
      writeFileSync(
        join(tempDir, '.claude', 'todos.json'),
        JSON.stringify({
          todos: [
            {
              content: 'finish the bug fix',
              status: 'pending',
              priority: 'high'
            }
          ]
        }),
      );

      const result = await checkPersistentModes(sessionId, tempDir);
      expect(result.shouldBlock).toBe(true);

      const output = createHookOutput(result);
      expect(output.continue).toBe(false);
      expect(output.message).toBeDefined();
    });

    it("auto-deactivates ultrawork and allows stop when all tracked work is complete", async () => {
      const sessionId = "test-session-complete";
      activateUltrawork("Task complete", sessionId, tempDir);
      const statePath = join(tempDir, '.omc', 'state', 'sessions', sessionId, 'ultrawork-state.json');

      const result = await checkPersistentModes(sessionId, tempDir);
      expect(result.shouldBlock).toBe(false);
      expect(result.mode).toBe('none');
      expect(result.message).toContain('ULTRAWORK COMPLETE');

      const output = createHookOutput(result);
      expect(output.continue).toBe(true);
      expect(output.message).toContain('ULTRAWORK COMPLETE');

      expect(() => readFileSync(statePath, 'utf-8')).toThrow();
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

    it("allows stop after broad clear removes leftover session-scoped state", async () => {
      const sessionA = "test-broad-clear-a";
      const sessionB = "test-broad-clear-b";
      const stateDir = join(tempDir, '.omc', 'state');
      const sessionADir = join(stateDir, 'sessions', sessionA);
      const sessionBDir = join(stateDir, 'sessions', sessionB);
      mkdirSync(sessionADir, { recursive: true });
      mkdirSync(sessionBDir, { recursive: true });
      writeFileSync(
        join(sessionADir, 'ralph-state.json'),
        JSON.stringify({
          active: true,
          iteration: 1,
          max_iterations: 10,
          session_id: sessionA,
          started_at: new Date().toISOString(),
          last_checked_at: new Date().toISOString(),
        }),
      );
      writeFileSync(
        join(sessionBDir, 'ralph-state.json'),
        JSON.stringify({
          active: true,
          iteration: 1,
          max_iterations: 10,
          session_id: sessionB,
          started_at: new Date().toISOString(),
          last_checked_at: new Date().toISOString(),
        }),
      );

      const { clearModeStateFile } = await import('../../lib/mode-state-io.js');
      expect(clearModeStateFile('ralph', tempDir)).toBe(true);

      const resultA = await checkPersistentModes(sessionA, tempDir);
      const outputA = createHookOutput(resultA);
      expect(outputA.continue).toBe(true);
      expect(resultA.shouldBlock).toBe(false);

      const resultB = await checkPersistentModes(sessionB, tempDir);
      const outputB = createHookOutput(resultB);
      expect(outputB.continue).toBe(true);
      expect(resultB.shouldBlock).toBe(false);
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

    it("keeps blocking active ralph loop when stop reason is interrupt", async () => {
      const sessionId = "test-ralph-interrupt";
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

      const result = await checkPersistentModes(sessionId, tempDir, {
        stop_reason: "interrupt",
      });
      expect(result.shouldBlock).toBe(true);
      expect(result.mode).toBe("ralph");

      const output = createHookOutput(result);
      expect(output.continue).toBe(false);
      expect(output.message).toContain("RALPH");
    });

    it("ignores stale legacy ralph state when no session is provided", async () => {
      const staleAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      writeLegacyModeState(tempDir, "ralph-state.json", {
        active: true,
        iteration: 1,
        max_iterations: 50,
        started_at: staleAt,
        last_checked_at: staleAt,
        prompt: "Stale legacy ralph task",
      });

      const result = await checkPersistentModes(undefined, tempDir);
      expect(result.shouldBlock).toBe(false);
      expect(result.mode).toBe("none");
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


    it("returns continue: true when ralph is awaiting confirmation", () => {
      const sessionId = "ralph-awaiting-confirmation-mjs";
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "ralph-state.json"),
        JSON.stringify({
          active: true,
          awaiting_confirmation: true,
          iteration: 1,
          max_iterations: 50,
          session_id: sessionId,
          started_at: new Date().toISOString(),
          last_checked_at: new Date().toISOString(),
          prompt: "Test task",
        })
      );

      const output = runScript({ directory: tempDir, sessionId });
      expect(output.continue).toBe(true);
      expect(output.decision).toBeUndefined();
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

    it("returns continue: true for stale legacy ultrawork state without a session", () => {
      const staleAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      writeLegacyModeState(tempDir, "ultrawork-state.json", {
        active: true,
        started_at: staleAt,
        original_prompt: "Stale legacy ultrawork task",
        reinforcement_count: 0,
        last_checked_at: staleAt,
      });

      const output = runScript({ directory: tempDir });
      expect(output.continue).toBe(true);
      expect(output.decision).toBeUndefined();
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


    it("returns decision: block when autopilot awaiting_confirmation is stale", () => {
      const sessionId = "autopilot-stale-awaiting-confirmation-mjs";
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "autopilot-state.json"),
        JSON.stringify({
          active: true,
          phase: "execution",
          iteration: 1,
          max_iterations: 10,
          awaiting_confirmation: true,
          awaiting_confirmation_set_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
          originalIdea: "test",
          expansion: { analyst_complete: false, architect_complete: false, spec_path: null, requirements_summary: "", tech_stack: [] },
          planning: { plan_path: null, architect_iterations: 0, approved: false },
          execution: { ralph_iterations: 0, ultrawork_active: false, tasks_completed: 0, tasks_total: 0, files_created: [], files_modified: [] },
          qa: { ultraqa_cycles: 0, build_status: "pending", lint_status: "pending", test_status: "pending" },
          validation: { architects_spawned: 0, verdicts: [], all_approved: false, validation_rounds: 0 },
          started_at: new Date().toISOString(),
          completed_at: null,
          phase_durations: {},
          total_agents_spawned: 0,
          wisdom_entries: 0,
          session_id: sessionId,
          project_path: tempDir,
        })
      );

      const output = runScript({ directory: tempDir, sessionId });
      expect(output.decision).toBe("block");
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

    it("does not block explicit /ralplan startup while awaiting confirmation", () => {
      const sessionId = "ralplan-explicit-slash-startup";
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "ralplan-state.json"),
        JSON.stringify({
          active: true,
          session_id: sessionId,
          current_phase: "ralplan",
          original_prompt: "/oh-my-claudecode:ralplan issue #2622",
          awaiting_confirmation: true,
          awaiting_confirmation_set_at: new Date().toISOString(),
          started_at: new Date().toISOString(),
          last_checked_at: new Date().toISOString(),
        })
      );

      const output = runScript({ directory: tempDir, sessionId });
      expect(output.continue).toBe(true);
      expect(output.decision).toBeUndefined();
    });


    it("returns continue: true when ultrawork is awaiting confirmation in cjs script", () => {
      const sessionId = "ultrawork-awaiting-confirmation-cjs";
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "ultrawork-state.json"),
        JSON.stringify({
          active: true,
          awaiting_confirmation: true,
          started_at: new Date().toISOString(),
          original_prompt: "Test task",
          session_id: sessionId,
          reinforcement_count: 0,
          last_checked_at: new Date().toISOString(),
          project_path: tempDir,
        })
      );

      const output = runScript({ directory: tempDir, sessionId });
      expect(output.continue).toBe(true);
      expect(output.decision).toBeUndefined();
    });

    it("returns decision: block when autopilot awaiting_confirmation is stale in cjs script", () => {
      const sessionId = "autopilot-stale-awaiting-confirmation-cjs";
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "autopilot-state.json"),
        JSON.stringify({
          active: true,
          phase: "execution",
          iteration: 1,
          max_iterations: 10,
          awaiting_confirmation: true,
          awaiting_confirmation_set_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
          originalIdea: "test",
          expansion: { analyst_complete: false, architect_complete: false, spec_path: null, requirements_summary: "", tech_stack: [] },
          planning: { plan_path: null, architect_iterations: 0, approved: false },
          execution: { ralph_iterations: 0, ultrawork_active: false, tasks_completed: 0, tasks_total: 0, files_created: [], files_modified: [] },
          qa: { ultraqa_cycles: 0, build_status: "pending", lint_status: "pending", test_status: "pending" },
          validation: { architects_spawned: 0, verdicts: [], all_approved: false, validation_rounds: 0 },
          started_at: new Date().toISOString(),
          completed_at: null,
          phase_durations: {},
          total_agents_spawned: 0,
          wisdom_entries: 0,
          session_id: sessionId,
          project_path: tempDir,
        })
      );

      const output = runScript({ directory: tempDir, sessionId });
      expect(output.decision).toBe("block");
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

    function runScript(
      input: Record<string, unknown>,
      envOverrides: Record<string, string | undefined> = {},
    ): Record<string, unknown> {
      try {
        const result = execSync(`node "${scriptPath}"`, {
          encoding: "utf-8",
          timeout: 5000,
          input: JSON.stringify(input),
          env: { ...process.env, NODE_ENV: "test", ...envOverrides },
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
      delete process.env.OMC_STATE_DIR;
    });

    afterEach(() => {
      delete process.env.OMC_STATE_DIR;
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("reads centralized session state when OMC_STATE_DIR is set", () => {
      const sessionId = "centralized-state-cjs";
      const customStateDir = join(tempDir, "centralized-state");
      const centralizedStateDir = resolveCentralizedStateDir(tempDir, customStateDir);
      const sessionDir = join(centralizedStateDir, "sessions", sessionId);
      writePendingTodo(tempDir, "Finish centralized task");
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "ultrawork-state.json"),
        JSON.stringify({
          active: true,
          original_prompt: "Centralized task",
          session_id: sessionId,
          reinforcement_count: 0,
          started_at: new Date().toISOString(),
          last_checked_at: new Date().toISOString(),
        }),
      );

      const output = runScript(
        { directory: tempDir, sessionId },
        { OMC_STATE_DIR: customStateDir },
      );

      expect(output.decision).toBe("block");
      expect(output.reason).toContain("ULTRAWORK");
    });

    it("ignores legacy local state when OMC_STATE_DIR is set", () => {
      const sessionId = "legacy-local-cjs";
      const localSessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      writePendingTodo(tempDir, "Finish centralized-only task");
      mkdirSync(localSessionDir, { recursive: true });
      writeFileSync(
        join(localSessionDir, "ultrawork-state.json"),
        JSON.stringify({
          active: true,
          original_prompt: "Stale local task",
          session_id: sessionId,
          reinforcement_count: 0,
          started_at: new Date().toISOString(),
          last_checked_at: new Date().toISOString(),
        }),
      );

      const output = runScript(
        { directory: tempDir, sessionId },
        { OMC_STATE_DIR: join(tempDir, "centralized-state") },
      );

      expect(output.continue).toBe(true);
      expect(output.decision).toBeUndefined();
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

    it("auto-deactivates ultrawork state when no incomplete work remains in cjs script", () => {
      const sessionId = "ulw-complete-cjs";
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      mkdirSync(sessionDir, { recursive: true });
      const statePath = join(sessionDir, "ultrawork-state.json");
      writeFileSync(
        statePath,
        JSON.stringify({
          active: true,
          session_id: sessionId,
          reinforcement_count: 2,
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
      expect(output.continue).toBe(true);

      const updatedState = JSON.parse(readFileSync(statePath, "utf-8"));
      expect(updatedState.active).toBe(false);
      expect(updatedState.deactivated_reason).toBe("task_completion");
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

    it.each([
      [{ current_phase: "aborted" }, "ralplan-aborted-cjs"],
      [{ phase: "terminated" }, "ralplan-terminated-phase-cjs"],
      [{ status: "handoff:ralph" }, "ralplan-handoff-status-cjs"],
    ])("allows stop for terminal ralplan state in cjs script: %s", (overrides, sessionId) => {
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "ralplan-state.json"),
        JSON.stringify({
          active: true,
          session_id: sessionId,
          started_at: new Date().toISOString(),
          ...overrides,
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

      mkdirSync(join(tempDir, '.claude'), { recursive: true });
      writeFileSync(
        join(tempDir, '.claude', 'todos.json'),
        JSON.stringify({
          todos: [
            {
              content: 'keep working',
              status: 'pending',
              priority: 'high'
            }
          ]
        }),
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
