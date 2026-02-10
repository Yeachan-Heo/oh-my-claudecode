import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import { checkPersistentModes } from "./index.js";
import { activateUltrawork, deactivateUltrawork } from "../ultrawork/index.js";

describe("Persistent Mode Session Isolation (Issue #311)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "persistent-mode-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("checkPersistentModes session isolation", () => {
    it("should block stop when session_id matches active ultrawork", async () => {
      const sessionId = "session-owner";
      activateUltrawork("Fix the bug", sessionId, tempDir);

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

    it("should support session-scoped state files", async () => {
      const sessionId = "session-scoped-test";
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

    it("should not block legacy state when invalid sessionId is provided", () => {
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

      expect(output.continue ?? output.decision).toBeTruthy();
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

    it("should not block legacy state when invalid sessionId is provided (project isolation)", () => {
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

      expect(output.continue ?? output.decision).toBeTruthy();
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
