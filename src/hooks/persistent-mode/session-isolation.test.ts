import { createHash } from "crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import { checkPersistentModes, createHookOutput } from "./index.js";
import { activateUltrawork, deactivateUltrawork } from "../ultrawork/index.js";
import { initAutopilot } from "../autopilot/index.js";

function writePendingTodo(tempDir: string, content: string): void {
  mkdirSync(join(tempDir, '.claude'), { recursive: true });
  writeFileSync(
    join(tempDir, '.claude', 'todos.json'),
    JSON.stringify({
      todos: [
        {
          content,
          status: 'pending',
          priority: 'high',
        },
      ],
    }),
  );
}

describe("Persistent Mode Session Isolation (Issue #311)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "persistent-mode-test-"));
    execSync('git init', { cwd: tempDir });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.OMC_TEST_FLOCK_AVAILABLE;
  });

  describe("checkPersistentModes session isolation", () => {
    it("should block stop when session_id matches active ultrawork", async () => {
      const sessionId = "session-owner";
      activateUltrawork("Fix the bug", sessionId, tempDir);
      writePendingTodo(tempDir, "Finish the bug fix");

      const result = await checkPersistentModes(sessionId, tempDir);
      expect(result.shouldBlock).toBe(true);
      expect(result.mode).toBe("ultrawork");
    });

    it("should NOT block stop when session_id does not match", async () => {
      const ownerSession = "session-owner";
      const otherSession = "session-intruder";
      activateUltrawork("Fix the bug", ownerSession, tempDir);

      const result = await checkPersistentModes(otherSession, tempDir);
      expect(result.shouldBlock).toBe(false);
      expect(result.mode).toBe("none");
    });

    it("should NOT block when no ultrawork state exists", async () => {
      const result = await checkPersistentModes("any-session", tempDir);
      expect(result.shouldBlock).toBe(false);
      expect(result.mode).toBe("none");
    });

    it("should NOT block after ultrawork is deactivated", async () => {
      const sessionId = "session-done";
      activateUltrawork("Task complete", sessionId, tempDir);
      deactivateUltrawork(tempDir, sessionId);

      const result = await checkPersistentModes(sessionId, tempDir);
      expect(result.shouldBlock).toBe(false);
    });

    it("should NOT block when session_id is undefined and state has session_id", async () => {
      activateUltrawork("Task", "session-with-id", tempDir);

      const result = await checkPersistentModes(undefined, tempDir);
      expect(result.shouldBlock).toBe(false);
    });

    it("propagates a named workflow integrity diagnostic through the public Stop output", async () => {
      const sessionId = "partial-named-diagnostic";
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "autopilot-state.json"),
        JSON.stringify({
          active: true,
          phase: "ralplan",
          session_id: sessionId,
          project_path: tempDir,
          started_at: new Date().toISOString(),
          workflow: false,
        }),
      );

      const result = await checkPersistentModes(sessionId, tempDir);

      expect(result).toMatchObject({
        shouldBlock: false,
        mode: "autopilot",
        message: "workflow_descriptor_integrity_failed",
      });
      expect(createHookOutput(result)).toEqual({
        continue: true,
        message: "workflow_descriptor_integrity_failed",
      });
    });

    it("honors requested_at cancellation for an active non-autopilot mode beside a terminal named record", async () => {
      const sessionId = "terminal-named-cancel-coexist";
      activateUltrawork("Finish the task", sessionId, tempDir);
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      writeFileSync(
        join(sessionDir, "autopilot-state.json"),
        JSON.stringify({
          active: true,
          phase: "complete",
          session_id: sessionId,
          project_path: tempDir,
          started_at: new Date().toISOString(),
          workflow: false,
        }),
      );
      writeFileSync(
        join(sessionDir, "cancel-signal-state.json"),
        JSON.stringify({ requested_at: new Date().toISOString() }),
      );

      await expect(checkPersistentModes(sessionId, tempDir)).resolves.toMatchObject({
        shouldBlock: false,
        mode: "none",
      });
    });

    it("requires an authenticated exact digest before cancelling an active legacy autopilot target", async () => {
      const sessionId = "legacy-autopilot-cancel-auth";
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      mkdirSync(sessionDir, { recursive: true });
      const state = initAutopilot(tempDir, "Finish the task", sessionId)!;
      state.phase = "planning";
      state.project_path = tempDir;
      writeFileSync(join(sessionDir, "autopilot-state.json"), JSON.stringify(state));
      const signalPath = join(sessionDir, "cancel-signal-state.json");
      const signal = (target_state_sha256?: string) => ({
        active: true,
        mode: "autopilot",
        source: "state_clear",
        requested_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 30_000).toISOString(),
        ...(target_state_sha256 ? { target_state_sha256 } : {}),
      });

      writeFileSync(signalPath, JSON.stringify(signal()));
      await expect(checkPersistentModes(sessionId, tempDir)).resolves.toMatchObject({
        shouldBlock: true,
        mode: "autopilot",
      });

      const currentState = JSON.parse(readFileSync(join(sessionDir, "autopilot-state.json"), "utf-8"));
      writeFileSync(
        signalPath,
        JSON.stringify(signal(createHash("sha256").update(JSON.stringify(currentState)).digest("hex"))),
      );
      await expect(checkPersistentModes(sessionId, tempDir)).resolves.toMatchObject({
        shouldBlock: false,
        mode: "none",
      });
    });

    it("does not honor an autopilot cancel signal without an exclusive state lock", async () => {
      const sessionId = "legacy-autopilot-cancel-no-flock";
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      mkdirSync(sessionDir, { recursive: true });
      const state = initAutopilot(tempDir, "Finish the task", sessionId)!;
      state.phase = "planning";
      state.project_path = tempDir;
      writeFileSync(join(sessionDir, "autopilot-state.json"), JSON.stringify(state));
      const now = Date.now();
      writeFileSync(join(sessionDir, "cancel-signal-state.json"), JSON.stringify({
        active: true,
        mode: "autopilot",
        source: "state_clear",
        requested_at: new Date(now).toISOString(),
        expires_at: new Date(now + 30_000).toISOString(),
        target_state_sha256: createHash("sha256").update(JSON.stringify(state)).digest("hex"),
      }));
      process.env.OMC_TEST_FLOCK_AVAILABLE = "0";

      await expect(checkPersistentModes(sessionId, tempDir)).resolves.toMatchObject({
        shouldBlock: true,
        mode: "autopilot",
      });
    });

    it("honors a requested-at-only Ultrawork cancellation without flock when canonical autopilot discovery finds no target", async () => {
      const sessionId = "portable-generic-cancel-no-autopilot";
      activateUltrawork("Finish the task", sessionId, tempDir);
      writePendingTodo(tempDir, "Finish the task");
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      writeFileSync(join(sessionDir, "cancel-signal-state.json"), JSON.stringify({
        active: true,
        requested_at: new Date().toISOString(),
        source: "state_clear",
      }));
      process.env.OMC_TEST_FLOCK_AVAILABLE = "0";

      await expect(checkPersistentModes(sessionId, tempDir)).resolves.toMatchObject({
        shouldBlock: false,
        mode: "none",
      });
    });

    it.each([
      ["active", (state: Record<string, unknown>) => state],
      ["replacement", (state: Record<string, unknown>) => ({ ...state, originalIdea: "Replacement run" })],
    ])("does not let a requested-at-only Ultrawork cancellation suppress a %s autopilot without flock", async (_name, replace) => {
      const sessionId = `portable-generic-cancel-autopilot-${_name}`;
      activateUltrawork("Finish the task", sessionId, tempDir);
      writePendingTodo(tempDir, "Finish the task");
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      mkdirSync(sessionDir, { recursive: true });
      const state = initAutopilot(tempDir, "Finish the task", sessionId)!;
      state.phase = "planning";
      state.project_path = tempDir;
      writeFileSync(join(sessionDir, "autopilot-state.json"), JSON.stringify(replace(state as unknown as Record<string, unknown>)));
      writeFileSync(join(sessionDir, "cancel-signal-state.json"), JSON.stringify({
        active: true,
        requested_at: new Date().toISOString(),
        source: "state_clear",
      }));
      process.env.OMC_TEST_FLOCK_AVAILABLE = "0";

      await expect(checkPersistentModes(sessionId, tempDir)).resolves.toMatchObject({
        shouldBlock: true,
        mode: "autopilot",
      });
    });

    it.each([
      ['stage advance', (state: Record<string, unknown>) => ({ ...state, phase: 'execution' })],
      ['replacement run', (state: Record<string, unknown>) => ({ ...state, originalIdea: 'Replacement run' })],
    ])('does not let a cancel signal for a prior autopilot generation suppress a %s', async (_name, replace) => {
      const sessionId = `autopilot-cancel-prior-generation-${_name.replace(' ', '-')}`;
      const sessionDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      const state = initAutopilot(tempDir, 'Finish the task', sessionId)!;
      state.phase = 'planning';
      state.project_path = tempDir;
      const statePath = join(sessionDir, 'autopilot-state.json');
      const signalPath = join(sessionDir, 'cancel-signal-state.json');
      writeFileSync(statePath, JSON.stringify(state));
      writeFileSync(signalPath, JSON.stringify({
        active: true,
        mode: 'autopilot',
        source: 'state_clear',
        requested_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 30_000).toISOString(),
        target_state_sha256: createHash('sha256').update(JSON.stringify(state)).digest('hex'),
      }));
      writeFileSync(statePath, JSON.stringify(replace(state as unknown as Record<string, unknown>)));

      await expect(checkPersistentModes(sessionId, tempDir)).resolves.toMatchObject({
        shouldBlock: true,
        mode: 'autopilot',
      });
    });

    it.each([
      ['future-dated', 6_000, true],
      ['stale', -30_001, true],
      ['fresh', 0, false],
    ])('applies requested_at freshness to an exact-digest active legacy autopilot cancellation (%s)', async (_name, offsetMs, shouldBlock) => {
      const sessionId = `legacy-autopilot-cancel-freshness-${offsetMs}`;
      const sessionDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      const state = initAutopilot(tempDir, 'Finish the task', sessionId)!;
      state.phase = 'planning';
      state.project_path = tempDir;
      writeFileSync(join(sessionDir, 'autopilot-state.json'), JSON.stringify(state));
      const requestedAt = Date.now() + offsetMs;
      writeFileSync(join(sessionDir, 'cancel-signal-state.json'), JSON.stringify({
        active: true,
        mode: 'autopilot',
        source: 'state_clear',
        requested_at: new Date(requestedAt).toISOString(),
        expires_at: new Date(requestedAt + 30_000).toISOString(),
        target_state_sha256: createHash('sha256').update(JSON.stringify(state)).digest('hex'),
      }));

      await expect(checkPersistentModes(sessionId, tempDir)).resolves.toMatchObject({
        shouldBlock,
        mode: shouldBlock ? 'autopilot' : 'none',
      });
    });

    it.each([
      ['future-dated', 6_000, true],
      ['stale', -30_001, true],
      ['fresh', 0, false],
    ])('applies requested_at freshness to requested_at-only non-autopilot cancellation (%s)', async (_name, offsetMs, shouldBlock) => {
      const sessionId = `ultrawork-cancel-freshness-${offsetMs}`;
      activateUltrawork('Finish the task', sessionId, tempDir);
      writePendingTodo(tempDir, 'Finish the task');
      const requestedAt = Date.now() + offsetMs;
      const sessionDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
      writeFileSync(join(sessionDir, 'cancel-signal-state.json'), JSON.stringify({
        active: true,
        requested_at: new Date(requestedAt).toISOString(),
        source: 'state_clear',
      }));

      await expect(checkPersistentModes(sessionId, tempDir)).resolves.toMatchObject({
        shouldBlock,
        mode: shouldBlock ? 'ultrawork' : 'none',
      });
    });

    it("should support session-scoped state files", async () => {
      const sessionId = "session-scoped-test";
      writePendingTodo(tempDir, "Finish the session-scoped task");
      // Create state in session-scoped directory
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "ultrawork-state.json"),
        JSON.stringify({
          active: true,
          started_at: new Date().toISOString(),
          original_prompt: "Session-scoped task",
          session_id: sessionId,
          reinforcement_count: 0,
          last_checked_at: new Date().toISOString(),
        }, null, 2)
      );

      const result = await checkPersistentModes(sessionId, tempDir);
      expect(result.shouldBlock).toBe(true);
      expect(result.mode).toBe("ultrawork");
    });

    it("Session A cannot see Session B state in session-scoped dirs", async () => {
      const sessionA = "session-A";
      const sessionB = "session-B";

      // Create state for session B in session-scoped directory
      const sessionDirB = join(tempDir, ".omc", "state", "sessions", sessionB);
      mkdirSync(sessionDirB, { recursive: true });
      writeFileSync(
        join(sessionDirB, "ultrawork-state.json"),
        JSON.stringify({
          active: true,
          started_at: new Date().toISOString(),
          original_prompt: "Session B task",
          session_id: sessionB,
          reinforcement_count: 0,
          last_checked_at: new Date().toISOString(),
        }, null, 2)
      );

      // Session A should NOT be blocked by Session B's state
      const result = await checkPersistentModes(sessionA, tempDir);
      expect(result.shouldBlock).toBe(false);
      expect(result.mode).toBe("none");
    });
  });

  describe("persistent-mode.mjs script session isolation", () => {
    const scriptPath = join(process.cwd(), "scripts", "persistent-mode.mjs");

    function runPersistentModeScript(
      input: Record<string, unknown>,
    ): Record<string, unknown> {
      try {
        const result = execSync(`node "${scriptPath}"`, {
          encoding: "utf-8",
          timeout: 5000,
          input: JSON.stringify(input),
          env: { ...process.env, NODE_ENV: "test" },
        });
        // The script may output multiple lines (stderr + stdout)
        // Parse the last line which should be the JSON output
        const lines = result.trim().split("\n");
        const lastLine = lines[lines.length - 1];
        return JSON.parse(lastLine);
      } catch (error: unknown) {
        const execError = error as { stdout?: string; stderr?: string };
        // execSync throws on non-zero exit, but script should always exit 0
        if (execError.stdout) {
          const lines = execError.stdout.trim().split("\n");
          const lastLine = lines[lines.length - 1];
          return JSON.parse(lastLine);
        }
        throw error;
      }
    }

    function createUltraworkState(
      dir: string,
      sessionId: string,
      prompt: string,
    ): void {
      // Write to session-scoped path (matches new session-first behavior)
      const sessionDir = join(dir, ".omc", "state", "sessions", sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "ultrawork-state.json"),
        JSON.stringify(
          {
            active: true,
            started_at: new Date().toISOString(),
            original_prompt: prompt,
            session_id: sessionId,
            reinforcement_count: 0,
            last_checked_at: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    }

    it("should block when sessionId matches ultrawork state", () => {
      const sessionId = "test-session-match";
      createUltraworkState(tempDir, sessionId, "Test task");

      const output = runPersistentModeScript({
        directory: tempDir,
        sessionId: sessionId,
      });

      expect(output.decision).toBe("block");
      expect(output.reason).toContain("ULTRAWORK");
    });

    it("should NOT block when sessionId does not match ultrawork state", () => {
      createUltraworkState(tempDir, "session-A", "Task for A");

      const output = runPersistentModeScript({
        directory: tempDir,
        sessionId: "session-B",
      });

      // Should allow stop (continue: true) because session doesn't match
      expect(output.continue).toBe(true);
      expect(output.decision).toBeUndefined();
    });

    it("should NOT block for legacy state when sessionId is provided (session isolation)", () => {
      const stateDir = join(tempDir, ".omc", "state");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, "ultrawork-state.json"),
        JSON.stringify(
          {
            active: true,
            started_at: new Date().toISOString(),
            original_prompt: "Legacy task",
            reinforcement_count: 0,
            last_checked_at: new Date().toISOString(),
            // Note: no session_id field
          },
          null,
          2,
        ),
      );

      const output = runPersistentModeScript({
        directory: tempDir,
        sessionId: "any-session",
      });

      // Legacy state is invisible when sessionId is known (session-first behavior)
      expect(output.continue).toBe(true);
      expect(output.decision).toBeUndefined();
    });

    it("should ignore invalid sessionId when reading session-scoped state", () => {
      const sessionId = "session-valid";
      createUltraworkState(tempDir, sessionId, "Session task");

      const output = runPersistentModeScript({
        directory: tempDir,
        sessionId: "../session-valid",
      });

      expect(output.continue).toBe(true);
      expect(output.decision).toBeUndefined();
    });

    it("should block legacy state when invalid sessionId is provided (falls back to legacy)", () => {
      const stateDir = join(tempDir, ".omc", "state");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, "ultrawork-state.json"),
        JSON.stringify(
          {
            active: true,
            started_at: new Date().toISOString(),
            original_prompt: "Legacy task",
            reinforcement_count: 0,
            last_checked_at: new Date().toISOString(),
          },
          null,
          2,
        ),
      );

      const output = runPersistentModeScript({
        directory: tempDir,
        sessionId: "../session-valid",
      });

      // Invalid sessionId sanitizes to "", falls back to legacy path, blocks
      expect(output.decision).toBe("block");
    });

    it("should allow stop when cancel signal only includes requested_at", () => {
      const sessionId = "session-cancel-requested-at";
      createUltraworkState(tempDir, sessionId, "Task being cancelled");

      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      writeFileSync(
        join(sessionDir, "cancel-signal-state.json"),
        JSON.stringify(
          {
            active: true,
            requested_at: new Date().toISOString(),
            source: "test"
          },
          null,
          2,
        ),
      );

      const output = runPersistentModeScript({
        directory: tempDir,
        sessionId,
      });

      expect(output.continue).toBe(true);
      expect(output.decision).toBeUndefined();
    });

    it.each([
      ["inactive", { active: false, session_id: "session-cancel-coexist", project_path: "/inactive-project" }],
      ["cross-project", { active: true, phase: "execution", session_id: "session-cancel-coexist", project_path: "/other-project", last_checked_at: new Date().toISOString() }],
    ])("allows requested_at-only cancellation for ultrawork with a %s autopilot record", (_kind, autopilotState) => {
      const sessionId = "session-cancel-coexist";
      createUltraworkState(tempDir, sessionId, "Task being cancelled");
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      writeFileSync(join(sessionDir, "autopilot-state.json"), JSON.stringify(autopilotState));
      writeFileSync(join(sessionDir, "cancel-signal-state.json"), JSON.stringify({
        active: true,
        requested_at: new Date().toISOString(),
        source: "test",
      }));

      expect(runPersistentModeScript({ directory: tempDir, sessionId })).toMatchObject({ continue: true });
    });

    it("should NOT block for legacy autopilot state when sessionId is provided", () => {
      const stateDir = join(tempDir, ".omc", "state");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, "autopilot-state.json"),
        JSON.stringify(
          {
            active: true,
            phase: "execution",
            reinforcement_count: 0,
            last_checked_at: new Date().toISOString(),
          },
          null,
          2,
        ),
      );

      const output = runPersistentModeScript({
        directory: tempDir,
        sessionId: "any-session",
      });

      expect(output.continue).toBe(true);
      expect(output.decision).toBeUndefined();
    });

    it("should block for legacy state when no sessionId provided (backward compat)", () => {
      const stateDir = join(tempDir, ".omc", "state");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, "ultrawork-state.json"),
        JSON.stringify(
          {
            active: true,
            started_at: new Date().toISOString(),
            original_prompt: "Legacy task",
            reinforcement_count: 0,
            last_checked_at: new Date().toISOString(),
          },
          null,
          2,
        ),
      );

      const output = runPersistentModeScript({
        directory: tempDir,
      });

      // Legacy state blocks when no sessionId (backward compat)
      expect(output.decision).toBe("block");
      expect(output.reason).toContain("ULTRAWORK");
    });

    it("should block for legacy autopilot state when no sessionId provided", () => {
      const stateDir = join(tempDir, ".omc", "state");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, "autopilot-state.json"),
        JSON.stringify(
          {
            active: true,
            phase: "execution",
            reinforcement_count: 0,
            last_checked_at: new Date().toISOString(),
          },
          null,
          2,
        ),
      );

      const output = runPersistentModeScript({
        directory: tempDir,
      });

      expect(output.decision).toBe("block");
      expect(output.reason).toContain("AUTOPILOT");
      expect(output.reason).not.toContain('/oh-my-claudecode:cancel');
    });

    it("should include cancel guidance only for session-owned autopilot state", () => {
      const sessionId = "session-autopilot-owned";
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "autopilot-state.json"),
        JSON.stringify(
          {
            active: true,
            phase: "execution",
            session_id: sessionId,
            reinforcement_count: 0,
            last_checked_at: new Date().toISOString(),
          },
          null,
          2,
        ),
      );

      const output = runPersistentModeScript({
        directory: tempDir,
        sessionId,
      });

      expect(output.decision).toBe("block");
      expect(output.reason).toContain('/oh-my-claudecode:cancel');
      expect(output.reason).toContain("this session's autopilot state files");
    });
  });

  describe("session key alias compatibility (sessionId/session_id/sessionid)", () => {
    const scriptPath = join(process.cwd(), "scripts", "persistent-mode.mjs");

    function runPersistentModeScript(
      input: Record<string, unknown>,
    ): Record<string, unknown> {
      try {
        const result = execSync(`node "${scriptPath}"`, {
          encoding: "utf-8",
          timeout: 5000,
          input: JSON.stringify(input),
          env: { ...process.env, NODE_ENV: "test" },
        });
        const lines = result.trim().split("\n");
        const lastLine = lines[lines.length - 1];
        return JSON.parse(lastLine);
      } catch (error: unknown) {
        const execError = error as { stdout?: string; stderr?: string };
        if (execError.stdout) {
          const lines = execError.stdout.trim().split("\n");
          const lastLine = lines[lines.length - 1];
          return JSON.parse(lastLine);
        }
        throw error;
      }
    }

    function createUltraworkState(
      dir: string,
      sessionId: string,
      prompt: string,
    ): void {
      const sessionDir = join(dir, ".omc", "state", "sessions", sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "ultrawork-state.json"),
        JSON.stringify(
          {
            active: true,
            started_at: new Date().toISOString(),
            original_prompt: prompt,
            session_id: sessionId,
            reinforcement_count: 0,
            last_checked_at: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    }

    it("should accept sessionId (camelCase) for session identification", () => {
      const sessionId = "test-session-camel";
      createUltraworkState(tempDir, sessionId, "Test task");

      const output = runPersistentModeScript({
        directory: tempDir,
        sessionId: sessionId,
      });

      expect(output.decision).toBe("block");
      expect(output.reason).toContain("ULTRAWORK");
    });

    it("should accept session_id (snake_case) for session identification", () => {
      const sessionId = "test-session-snake";
      createUltraworkState(tempDir, sessionId, "Test task");

      const output = runPersistentModeScript({
        directory: tempDir,
        session_id: sessionId,
      });

      expect(output.decision).toBe("block");
      expect(output.reason).toContain("ULTRAWORK");
    });

    it("should accept sessionid (lowercase) for session identification", () => {
      const sessionId = "test-session-lower";
      createUltraworkState(tempDir, sessionId, "Test task");

      const output = runPersistentModeScript({
        directory: tempDir,
        sessionid: sessionId,
      });

      expect(output.decision).toBe("block");
      expect(output.reason).toContain("ULTRAWORK");
    });

    it("should prefer sessionId over session_id when both provided", () => {
      const correctSession = "correct-session";
      const wrongSession = "wrong-session";
      createUltraworkState(tempDir, correctSession, "Correct task");

      const output = runPersistentModeScript({
        directory: tempDir,
        sessionId: correctSession,  // This should be used
        session_id: wrongSession,   // This should be ignored
      });

      expect(output.decision).toBe("block");
      expect(output.reason).toContain("ULTRAWORK");
    });

    it("should prefer session_id over sessionid when both provided", () => {
      const correctSession = "correct-session";
      const wrongSession = "wrong-session";
      createUltraworkState(tempDir, correctSession, "Correct task");

      const output = runPersistentModeScript({
        directory: tempDir,
        session_id: correctSession,  // This should be used
        sessionid: wrongSession,     // This should be ignored
      });

      expect(output.decision).toBe("block");
      expect(output.reason).toContain("ULTRAWORK");
    });

    it("should prefer sessionId over sessionid when both provided", () => {
      const correctSession = "correct-session";
      const wrongSession = "wrong-session";
      createUltraworkState(tempDir, correctSession, "Correct task");

      const output = runPersistentModeScript({
        directory: tempDir,
        sessionId: correctSession,  // This should be used
        sessionid: wrongSession,    // This should be ignored
      });

      expect(output.decision).toBe("block");
      expect(output.reason).toContain("ULTRAWORK");
    });

    it("should fall back to session_id when sessionId is empty", () => {
      const sessionId = "fallback-session";
      createUltraworkState(tempDir, sessionId, "Fallback task");

      const output = runPersistentModeScript({
        directory: tempDir,
        sessionId: "",
        session_id: sessionId,
      });

      expect(output.decision).toBe("block");
      expect(output.reason).toContain("ULTRAWORK");
    });
  });

  describe("project isolation (project_path)", () => {
    const scriptPath = join(process.cwd(), "scripts", "persistent-mode.mjs");

    function runPersistentModeScript(
      input: Record<string, unknown>,
    ): Record<string, unknown> {
      try {
        const result = execSync(`node "${scriptPath}"`, {
          encoding: "utf-8",
          timeout: 5000,
          input: JSON.stringify(input),
          env: { ...process.env, NODE_ENV: "test" },
        });
        const lines = result.trim().split("\n");
        const lastLine = lines[lines.length - 1];
        return JSON.parse(lastLine);
      } catch (error: unknown) {
        const execError = error as { stdout?: string; stderr?: string };
        if (execError.stdout) {
          const lines = execError.stdout.trim().split("\n");
          const lastLine = lines[lines.length - 1];
          return JSON.parse(lastLine);
        }
        throw error;
      }
    }

    it("should block when project_path matches current directory", () => {
      // Write to session-scoped path (matches new session-first behavior)
      const sessionId = "session-123";
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "ultrawork-state.json"),
        JSON.stringify(
          {
            active: true,
            started_at: new Date().toISOString(),
            original_prompt: "Task in this project",
            session_id: sessionId,
            project_path: tempDir,
            reinforcement_count: 0,
            last_checked_at: new Date().toISOString(),
          },
          null,
          2,
        ),
      );

      const output = runPersistentModeScript({
        directory: tempDir,
        sessionId: sessionId,
      });

      expect(output.decision).toBe("block");
      expect(output.reason).toContain("ULTRAWORK");
    });

    it("should NOT block when project_path does not match current directory", () => {
      const stateDir = join(tempDir, ".omc", "state");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, "ultrawork-state.json"),
        JSON.stringify(
          {
            active: true,
            started_at: new Date().toISOString(),
            original_prompt: "Task in different project",
            session_id: "session-123",
            project_path: "/some/other/project",
            reinforcement_count: 0,
            last_checked_at: new Date().toISOString(),
          },
          null,
          2,
        ),
      );

      const output = runPersistentModeScript({
        directory: tempDir,
        sessionId: "session-123",
      });

      expect(output.continue).toBe(true);
      expect(output.decision).toBeUndefined();
    });

    it("should NOT block for legacy local state when sessionId provided (session isolation)", () => {
      const stateDir = join(tempDir, ".omc", "state");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, "ultrawork-state.json"),
        JSON.stringify(
          {
            active: true,
            started_at: new Date().toISOString(),
            original_prompt: "Legacy local task",
            reinforcement_count: 0,
            last_checked_at: new Date().toISOString(),
          },
          null,
          2,
        ),
      );

      const output = runPersistentModeScript({
        directory: tempDir,
        sessionId: "any-session",
      });

      // Legacy state is invisible when sessionId is known
      expect(output.continue).toBe(true);
      expect(output.decision).toBeUndefined();
    });

    it("should ignore invalid sessionId when checking session-scoped state", () => {
      const sessionId = "session-valid";
      const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "ultrawork-state.json"),
        JSON.stringify(
          {
            active: true,
            started_at: new Date().toISOString(),
            original_prompt: "Session task",
            session_id: sessionId,
            reinforcement_count: 0,
            last_checked_at: new Date().toISOString(),
          },
          null,
          2,
        ),
      );

      const output = runPersistentModeScript({
        directory: tempDir,
        sessionId: "..\\session-valid",
      });

      expect(output.continue).toBe(true);
      expect(output.decision).toBeUndefined();
    });

    it("should block legacy state when invalid sessionId is provided (falls back to legacy, project isolation)", () => {
      const stateDir = join(tempDir, ".omc", "state");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, "ultrawork-state.json"),
        JSON.stringify(
          {
            active: true,
            started_at: new Date().toISOString(),
            original_prompt: "Legacy local task",
            reinforcement_count: 0,
            last_checked_at: new Date().toISOString(),
          },
          null,
          2,
        ),
      );

      const output = runPersistentModeScript({
        directory: tempDir,
        sessionId: "..\\session-valid",
      });

      // Invalid sessionId sanitizes to "", falls back to legacy path, blocks
      expect(output.decision).toBe("block");
    });

    it("should block for legacy local state when no sessionId (backward compat)", () => {
      const stateDir = join(tempDir, ".omc", "state");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, "ultrawork-state.json"),
        JSON.stringify(
          {
            active: true,
            started_at: new Date().toISOString(),
            original_prompt: "Legacy local task",
            reinforcement_count: 0,
            last_checked_at: new Date().toISOString(),
          },
          null,
          2,
        ),
      );

      const output = runPersistentModeScript({
        directory: tempDir,
      });

      // Legacy state blocks when no sessionId
      expect(output.decision).toBe("block");
      expect(output.reason).toContain("ULTRAWORK");
    });
  });
});
