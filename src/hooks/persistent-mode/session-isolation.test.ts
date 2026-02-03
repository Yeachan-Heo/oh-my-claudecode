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
      deactivateUltrawork(tempDir);

      const result = await checkPersistentModes(sessionId, tempDir);
      expect(result.shouldBlock).toBe(false);
    });

    it("should NOT block when session_id is undefined and state has session_id", async () => {
      activateUltrawork("Task", "session-with-id", tempDir);

      const result = await checkPersistentModes(undefined, tempDir);
      expect(result.shouldBlock).toBe(false);
    });
  });

  describe("persistent-mode.cjs script session isolation", () => {
    const scriptPath = join(process.cwd(), "scripts", "persistent-mode.cjs");

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
      const stateDir = join(dir, ".omc", "state");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, "ultrawork-state.json"),
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

    it("should block for legacy state without session_id (backward compat)", () => {
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

      // Legacy state (no session_id) should still block for backward compat
      expect(output.decision).toBe("block");
      expect(output.reason).toContain("ULTRAWORK");
    });
  });

  describe("project isolation (project_path)", () => {
    const scriptPath = join(process.cwd(), "scripts", "persistent-mode.cjs");

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
      const stateDir = join(tempDir, ".omc", "state");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, "ultrawork-state.json"),
        JSON.stringify(
          {
            active: true,
            started_at: new Date().toISOString(),
            original_prompt: "Task in this project",
            session_id: "session-123",
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
        sessionId: "session-123",
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

    it("should block for legacy local state without project_path (backward compat)", () => {
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

      expect(output.decision).toBe("block");
      expect(output.reason).toContain("ULTRAWORK");
    });
  });
});
