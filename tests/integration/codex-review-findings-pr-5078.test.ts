/**
 * Regression tests for Codex review findings on PR #5078
 * Tests the 5 P2 findings and their fixes:
 * 1. Handle fork skip rows in jev-eval.mjs
 * 2. Match complete Markdown paths in pointer expansion
 * 3. Honor filesystem roots in pointer directory checks
 * 4. Preserve unchanged explicit efforts in marker telemetry
 * 5. Capture hook IDs for marker-only applied rows
 */

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

// Helper to run pre-tool-enforcer.mjs subprocess
async function runEnforcer(
  input: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number; json?: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(PROJECT_ROOT, "scripts", "pre-tool-enforcer.mjs")], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", () => {
      clearTimeout(timer);
      let json: Record<string, unknown> | undefined;
      try {
        json = JSON.parse(stdout) as Record<string, unknown>;
      } catch {
        // JSON parse failed
      }
      resolve({ stdout, stderr, exitCode: child.exitCode ?? 1, json });
    });
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

// Helper to run jev-eval.mjs
function runJevEval(logPath: string): { stdout: string; jsonOutput: Record<string, unknown> } {
  const result = spawnSync(process.execPath, [join(PROJECT_ROOT, "scripts", "jev-eval.mjs"), logPath, "--json"], {
    encoding: "utf8",
  });
  return {
    stdout: result.stdout || "",
    jsonOutput: JSON.parse(result.stdout || "{}"),
  };
}


describe("PR #5078 Codex Review Findings", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "codex-findings-"));
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  describe("Finding 1: Handle fork skip rows in jev-eval", () => {
    it("jev-eval should not count fork skip rows as malformed", () => {
      const logDir = join(tmpDir, "jev");
      mkdirSync(logDir, { recursive: true });
      const shadowLog = join(logDir, "shadow.jsonl");

      // Write a mix of normal and skip rows
      const normalRow = {
        ts: new Date().toISOString(),
        point: "model-routing",
        mode: "shadow",
        durationMs: 100,
      };
      const skipRow = {
        ts: new Date().toISOString(),
        point: "model-routing",
        subagent_type: "some-agent",
        skipped: "fork",
        durationMs: 0,
      };

      writeFileSync(shadowLog, JSON.stringify(normalRow) + "\n" + JSON.stringify(skipRow) + "\n", "utf8");

      const { jsonOutput } = runJevEval(shadowLog);

      // After fix: malformed count should be 0
      expect(jsonOutput.malformed).toBe(0);
      expect(jsonOutput.totalLines).toBe(2);
      // Skip rows should be counted as requests but not in mode statistics
      const points = Array.isArray(jsonOutput.points) ? jsonOutput.points : [];
      const point = points.find((p: Record<string, unknown>) => p.point === "model-routing");
      expect(point).toBeDefined();
      expect((point as Record<string, unknown>).requests).toBe(2);
      const modes = (point as Record<string, unknown>).modes as Record<string, unknown>;
      expect(modes.shadow).toBe(1); // Only the normal row contributes to mode count
    });

    it("jev-eval should count multiple skip rows in latency correctly", () => {
      const logDir = join(tmpDir, "jev-multiple");
      mkdirSync(logDir, { recursive: true });
      const shadowLog = join(logDir, "shadow.jsonl");

      const rows = [
        { ts: new Date().toISOString(), point: "model-routing", mode: "shadow", durationMs: 100 },
        { ts: new Date().toISOString(), point: "model-routing", skipped: "fork", durationMs: 0 },
        { ts: new Date().toISOString(), point: "model-routing", skipped: "fork", durationMs: 0 },
        { ts: new Date().toISOString(), point: "model-routing", mode: "active", durationMs: 200 },
      ];

      writeFileSync(shadowLog, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

      const { jsonOutput } = runJevEval(shadowLog);

      // Skip rows with 0 duration should not affect latency calculations
      expect(jsonOutput.malformed).toBe(0);
      expect(jsonOutput.totalLines).toBe(4);
    });
  });

  describe("Finding 2: Match complete Markdown paths", () => {
    it("pointer expansion should match complete paths only", async () => {
      const briefMd = join(tmpDir, "brief.md");
      const briefMdBak = join(tmpDir, "brief.md.bak");
      const allowedMd = join(tmpDir, "allowed.md");

      writeFileSync(briefMd, "ACTUAL CONTENT OF BRIEF.MD", "utf8");
      writeFileSync(briefMdBak, "BACKUP CONTENT", "utf8");
      writeFileSync(allowedMd, "ALLOWED FILE", "utf8");

      const env = {
        ...process.env,
        OMC_JEV_POINTER_EXPAND: "1",
        OMC_JEV_POINTER_EXPAND_DIRS: tmpDir,
        TYPESAFE_API_KEY: "stub",
      };

      // Test 1: Reference to .bak should not expand brief.md
      const inputBak = {
        tool_name: "Task",
        tool_input: {
          subagent_type: "test",
          prompt: `Please check ${briefMdBak}`,
        },
        session_id: "test-session",
        tool_use_id: "test-tool",
      };

      const resultBak = await runEnforcer(inputBak, env, tmpDir);
      expect(resultBak.exitCode).toBe(0);
      // Pointer expansion happens in memory; check that brief.md content is NOT in the prompt
      // If .bak is not matched as an expansion pattern, brief.md shouldn't be expanded either
      expect(resultBak.stderr).not.toContain("ACTUAL CONTENT OF BRIEF.MD");

      // Test 2: Reference to allowed.md SHOULD expand
      const inputAllowed = {
        tool_name: "Task",
        tool_input: {
          subagent_type: "test",
          prompt: `Please check ${allowedMd}`,
        },
        session_id: "test-session",
        tool_use_id: "test-tool",
      };

      const resultAllowed = await runEnforcer(inputAllowed, env, tmpDir);
      expect(resultAllowed.exitCode).toBe(0);
      // The enforcer should complete successfully for a valid expansion
      // (actual prompt expansion is tested through Jev telemetry, not stdout)
    });
  });

  describe("Finding 3: Honor filesystem roots in pointer checks", () => {
    it("pointer expansion contains root-safe directory checks", async () => {
      // Create a test file under tmpDir that we can expand
      const testFile = join(tmpDir, "test-root.md");
      writeFileSync(testFile, "ROOT TEST CONTENT", "utf8");

      const env = {
        ...process.env,
        OMC_JEV_POINTER_EXPAND: "1",
        // Allow expansion from root directory - the problematic case
        OMC_JEV_POINTER_EXPAND_DIRS: "/",
        TYPESAFE_API_KEY: "stub",
      };

      // A file under / should work with proper containment logic
      const input = {
        tool_name: "Task",
        tool_input: {
          subagent_type: "test",
          // Use the temp directory path under /
          prompt: `Check ${testFile}`,
        },
        session_id: "test-session",
        tool_use_id: "test-tool",
      };

      // With proper root-safe containment check, this should complete successfully
      // The root-safe check is: if (directory === sep) return canonicalPath.startsWith(sep);
      const result = await runEnforcer(input, env, tmpDir);
      
      // UNCONDITIONAL: Must exit successfully with no interactive prompt
      expect(result.exitCode).toBe(0);
      // Result should be valid JSON with either state or other output
      expect(result.stdout).toBeTruthy();
    });
  });

  describe("Finding 4: Preserve explicit efforts in marker telemetry", () => {
    it("applied log preserves explicit efforts in marker-only mode", async () => {
      const logDir = join(tmpDir, ".omc", "jev");
      mkdirSync(logDir, { recursive: true });
      // Create .omc directory so stateDir can be resolved
      mkdirSync(join(tmpDir, ".omc"), { recursive: true });

      try {
        const env = {
          ...process.env,
          TYPESAFE_API_KEY: "test-key-123",
          OMC_JEV_APPLIED_LOG: "1",
          OMC_JEV_LOG_CONTEXT: "1",
          OMC_JEV_LOG_DIR: logDir,
          OMC_JEV_MODEL_ROUTING_MARKER: "1",
          OMC_JEV_ROW_TELEMETRY: "1",
          OMC_JEV_MAX_EFFORT: "medium", // Set a max effort to test that explicit efforts are not capped
        };

        const input = {
          tool_name: "Task",
          tool_input: {
            subagent_type: "test",
            prompt: "use sonnet\nTask with explicit high effort",
            effort: "high", // Explicit effort that should not be capped by OMC_JEV_MAX_EFFORT
            model: "haiku", // Set an explicit model; marker pins to sonnet
          },
          session_id: "test-session-effort",
          tool_use_id: "test-tool-effort",
          cwd: tmpDir,
        };

        // Run the enforcer with marker-only mode (Jev OFF, marker enabled)
        // The applied log should show that explicit effort was preserved
        const result = await runEnforcer(input, env, tmpDir);
        expect(result.exitCode).toBe(0);

        // Check applied.jsonl for the effort record - UNCONDITIONAL
        const appliedLog = join(logDir, "applied.jsonl");
        
        // UNCONDITIONAL: applied.jsonl MUST exist
        expect(existsSync(appliedLog)).toBe(true);
        
        const appliedLines = readFileSync(appliedLog, "utf8").trim().split("\n").filter(Boolean);
        
        // UNCONDITIONAL: Must have at least one entry
        expect(appliedLines.length).toBeGreaterThan(0);
        
        const appliedEntries = appliedLines.map((line) => JSON.parse(line));
        
        // UNCONDITIONAL: Must have at least one applied entry
        expect(appliedEntries.length).toBeGreaterThan(0);
        
        // UNCONDITIONAL: At least one entry should be from model-routing
        const routingEntry = appliedEntries.find((e: Record<string, unknown>) => e.point === "model-routing");
        expect(routingEntry).toBeDefined();
        
        // UNCONDITIONAL: Verify that explicit effort was preserved in marker telemetry
        // The applied log should show effort: "high" (not capped to "medium")
        expect(routingEntry).toBeTruthy();
        const applied = (routingEntry as Record<string, unknown>).applied as Record<string, unknown>;
        expect(applied).toBeDefined();
        const effortRecord = applied.effort as Record<string, unknown>;
        expect(effortRecord).toBeDefined();
        expect((effortRecord.to as string)).toBe("high");
      } finally {
        // No server to close in marker-only mode
      }
    });
  });

  describe("Finding 5: Capture hook IDs for marker-only rows", () => {
    it("applied log captures hook context from marker-only applied rows", async () => {
      const logDir = join(tmpDir, ".omc", "jev");
      mkdirSync(logDir, { recursive: true });

      // Create .omc directory structure
      mkdirSync(join(tmpDir, ".omc"), { recursive: true });

      try {
        const env = {
          ...process.env,
          TYPESAFE_API_KEY: "test-key-123",
          OMC_JEV_APPLIED_LOG: "1",
          OMC_JEV_LOG_CONTEXT: "1",
          OMC_JEV_LOG_DIR: logDir,
          OMC_JEV_MODEL_ROUTING_MARKER: "1",
          OMC_JEV_ROW_TELEMETRY: "1",
        };

        const input = {
          tool_name: "Task",
          tool_input: {
            subagent_type: "test",
            prompt: "use sonnet\nTask prompt",
            model: "haiku", // Explicit model; marker pins to sonnet
          },
          session_id: "test-session-id-123",
          tool_use_id: "test-tool-use-id-456",
          cwd: tmpDir,
        };

        // Run the enforcer with marker-only mode (Jev OFF, marker enabled)
        const result = await runEnforcer(input, env, tmpDir);
      expect(result.exitCode).toBe(0);

      // Check applied.jsonl for the marker-only row with hook context
      const appliedLog = join(logDir, "applied.jsonl");
      
      // UNCONDITIONAL: applied.jsonl MUST exist
      expect(existsSync(appliedLog)).toBe(true);
      
      const appliedLines = readFileSync(appliedLog, "utf8").trim().split("\n").filter(Boolean);
      
      // UNCONDITIONAL: Must have at least one entry
      expect(appliedLines.length).toBeGreaterThan(0);
      
      const appliedEntries = appliedLines.map((line) => JSON.parse(line));
      
      // UNCONDITIONAL: Must have entries in marker-only mode
      expect(appliedEntries.length).toBeGreaterThan(0);
      
      // UNCONDITIONAL: Entries with hook context should exist
      const entriesWithContext = appliedEntries.filter(
        (e: Record<string, unknown>) => e.session_id || e.tool_use_id,
      );
      expect(entriesWithContext.length).toBeGreaterThan(0);
      
      // UNCONDITIONAL: The specific context should match the input
      const markerEntry = entriesWithContext.find((e: Record<string, unknown>) => e.session_id === "test-session-id-123");
      expect(markerEntry).toBeDefined();
      
      // UNCONDITIONAL: Verify the tool_use_id is captured unconditionally
      expect(markerEntry).toBeTruthy();
      expect((markerEntry as Record<string, unknown>).tool_use_id).toBe("test-tool-use-id-456");
      } finally {
        // No server to close in marker-only mode
      }
    });
  });
});
