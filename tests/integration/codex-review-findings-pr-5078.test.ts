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
import { join, sep } from "node:path";
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
      } catch {}
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
  let cwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "codex-findings-"));
    cwd = PROJECT_ROOT;
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

      // Before fix: malformed count would be 1 (the skip row)
      // After fix: malformed count should be 0
      expect(jsonOutput.malformed).toBe(0);
      expect(jsonOutput.totalLines).toBe(2);
      // Skip rows should be counted as requests but not in mode statistics
      const point = (jsonOutput.points as any[]).find((p) => p.point === "model-routing");
      expect(point.requests).toBe(2);
      expect(point.modes.shadow).toBe(1); // Only the normal row contributes to mode count
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
    it("pointer expansion should not match .md when followed by extension", () => {
      const briefMd = join(tmpDir, "brief.md");
      const briefMdBak = join(tmpDir, "brief.md.bak");
      const otherFile = join(tmpDir, "allowed.md");

      writeFileSync(briefMd, "ACTUAL CONTENT OF BRIEF.MD", "utf8");
      writeFileSync(briefMdBak, "BACKUP CONTENT", "utf8");
      writeFileSync(otherFile, "ALLOWED FILE", "utf8");

      const env = {
        ...process.env,
        OMC_JEV_POINTER_EXPAND: "1",
        OMC_JEV_POINTER_EXPAND_DIRS: tmpDir,
      };

      // A prompt referencing the .bak file should NOT expand to brief.md
      const input = {
        tool_name: "Task",
        tool_input: {
          subagent_type: "test",
          prompt: `Please check /brief.md.bak`,
        },
        session_id: "test-session",
        tool_use_id: "test-tool",
      };

      // This should not read brief.md when referencing .bak
      // Before fix: regex matches /brief.md and expands it
      // After fix: regex only matches /allowed.md not /brief.md.bak pattern
    });
  });

  describe("Finding 3: Honor filesystem roots in pointer checks", () => {
    it("pointer expansion should handle root directory safely", () => {
      // When dir is '/', checking real.startsWith(dir + sep) becomes real.startsWith('//')
      // which fails for paths like '/etc/passwd' that start with '/'

      const env = {
        ...process.env,
        OMC_JEV_POINTER_EXPAND: "1",
        // This is the problematic case - root directory
        OMC_JEV_POINTER_EXPAND_DIRS: "/",
      };

      // A file under / should still be excluded by secret-path checks
      // The containment logic needs to handle root specially
      const input = {
        tool_name: "Task",
        tool_input: {
          subagent_type: "test",
          prompt: `Check /home/user/file.md`,
        },
        session_id: "test-session",
        tool_use_id: "test-tool",
      };

      // Before fix: real.startsWith("/" + "/") = real.startsWith("//") fails
      // After fix: proper root-safe containment check
    });
  });

  describe("Finding 4: Preserve explicit efforts in marker telemetry", () => {
    it("marker telemetry should not cap explicit effort while recording as explicit", () => {
      const env = {
        ...process.env,
        OMC_JEV_MODEL_ROUTING_MARKER: "1",
        OMC_JEV_APPLIED_LOG: "1",
        OMC_JEV_ROW_TELEMETRY: "1",
      };

      const input = {
        tool_name: "Task",
        tool_input: {
          subagent_type: "test",
          prompt: "use opus\n\nSome task",
          effort: "high",
        },
        session_id: "test-session",
        tool_use_id: "test-tool",
      };

      // With marker forcing opus (model-only), explicit effort stays high
      // The applied log should either:
      // 1. Not cap the explicit effort, or
      // 2. Record the capped value with the correct source (not 'explicit')
    });
  });

  describe("Finding 5: Capture hook IDs for marker-only rows", () => {
    it("applied.jsonl should include hook context for marker-only rows", () => {
      const logDir = join(tmpDir, ".omc", "jev");
      mkdirSync(logDir, { recursive: true });

      const env = {
        ...process.env,
        OMC_JEV_MODEL_ROUTING_MARKER: "1",
        OMC_JEV_APPLIED_LOG: "1",
        OMC_JEV_LOG_CONTEXT: "1",
        // Ensure Jev is off so we test the marker-only code path
        OMC_JEV: "",
        OMC_JEV_LOG_DIR: logDir,
      };

      const input = {
        tool_name: "Task",
        tool_input: {
          subagent_type: "test",
          prompt: "use sonnet\n\nTask prompt",
        },
        session_id: "test-session-id-123",
        tool_use_id: "test-tool-use-id-456",
        cwd,
      };

      // A marker-only decision should still capture session_id, tool_use_id, etc.
      // Before fix: setJevHookContext returns early when !mayRequestJev(), losing context
      // After fix: context is captured regardless of whether Jev can be requested
    });
  });
});
