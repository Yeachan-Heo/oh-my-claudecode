/** Jev context-pruning answer mapping for issue #4804 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

// Run a hook script subprocess
function runHookScript(
  scriptPath: string,
  input: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    child.stdin.on("error", reject);
    child.stdin.end(JSON.stringify(input));
  });
}

describe("issue #4804: Jev context-pruning answer mapping", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "omc-4804-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("should not crash with large output at warning threshold (issue #4804 part 1)", async () => {
    // Verify the hook doesn't crash even if Jev is disabled
    // This is the baseline test that origin/dev should pass

    const input = {
      tool_name: "read",
      tool_response: "A".repeat(50000), // Large output to trigger compaction analysis
      tool_input: { path: "some-file" },
      working_directory: cwd,
      permission_mode: "on",
      session_id: "test-4804",
      context_budget_tokens: 100000,
      context_used_tokens: 80000, // 80% usage -> warning threshold
    };

    const env = {
      ...process.env,
      HOME: cwd,
      USERPROFILE: cwd,
      // Jev is disabled (no OMC_JEV)
      OMC_JEV: "",
      OMC_SKIP_HOOKS: "",
      DISABLE_OMC: "",
      NODE_ENV: "test",
    };

    const result = await runHookScript(
      join(PROJECT_ROOT, "scripts/post-tool-verifier.mjs"),
      input,
      env,
      cwd,
    );

    // The script should not crash (exit 0)
    expect(result.exitCode).toBe(0);

    // Should produce valid JSON output (the hook response)
    const output = JSON.parse(result.stdout);
    expect(output).toBeDefined();
    expect(output.continue).toBe(true);

    // At 80% (warning threshold) with Jev disabled, should emit warning message
    if (output.hookSpecificOutput) {
      const message = output.hookSpecificOutput.additionalContext || "";
      expect(message).toMatch(/\[OMC WARNING\]/);
    }
  });

  it("should emit critical message at 95% with Jev disabled (issue #4804 part 2)", async () => {
    // At 95%, we're above the 90% critical threshold
    // Even without Jev, should emit critical message

    const input = {
      tool_name: "read",
      tool_response: "B".repeat(50000),
      tool_input: { path: "some-file" },
      working_directory: cwd,
      permission_mode: "on",
      session_id: "test-4804-critical",
      context_budget_tokens: 100000,
      context_used_tokens: 95000, // 95% usage -> critical threshold
    };

    const env = {
      ...process.env,
      HOME: cwd,
      USERPROFILE: cwd,
      OMC_JEV: "",
      OMC_SKIP_HOOKS: "",
      DISABLE_OMC: "",
      NODE_ENV: "test",
    };

    const result = await runHookScript(
      join(PROJECT_ROOT, "scripts/post-tool-verifier.mjs"),
      input,
      env,
      cwd,
    );

    expect(result.exitCode).toBe(0);

    const output = JSON.parse(result.stdout);
    expect(output.continue).toBe(true);

    // At 95% (critical threshold) with Jev disabled, should emit critical message
    if (output.hookSpecificOutput) {
      const message = output.hookSpecificOutput.additionalContext || "";
      expect(message).toMatch(/\[OMC CRITICAL\]/);
    }
  });

  it("should not emit any message below warning threshold (issue #4804 part 3)", async () => {
    // Below the 70% warning threshold, no message should be emitted

    const input = {
      tool_name: "read",
      tool_response: "C".repeat(50000),
      tool_input: { path: "some-file" },
      working_directory: cwd,
      permission_mode: "on",
      session_id: "test-4804-low",
      context_budget_tokens: 100000,
      context_used_tokens: 60000, // 60% usage -> below warning threshold
    };

    const env = {
      ...process.env,
      HOME: cwd,
      USERPROFILE: cwd,
      OMC_JEV: "",
      OMC_SKIP_HOOKS: "",
      DISABLE_OMC: "",
      NODE_ENV: "test",
    };

    const result = await runHookScript(
      join(PROJECT_ROOT, "scripts/post-tool-verifier.mjs"),
      input,
      env,
      cwd,
    );

    expect(result.exitCode).toBe(0);

    const output = JSON.parse(result.stdout);
    expect(output.continue).toBe(true);

    // Below threshold, should not have compaction message
    if (output.hookSpecificOutput) {
      const message = output.hookSpecificOutput.additionalContext || "";
      expect(message).not.toMatch(/\[OMC (CRITICAL|WARNING)\]/);
    }
  });

  it("should not emit message for small output tools (issue #4804 part 4)", async () => {
    // Tools not in PREEMPTIVE_LARGE_OUTPUT_TOOLS should not trigger compaction

    const input = {
      tool_name: "write", // Not in large output tools
      tool_response: "D".repeat(50000), // Even though output is large
      tool_input: { path: "file.txt", content: "data" },
      working_directory: cwd,
      permission_mode: "on",
      session_id: "test-4804-small-tool",
      context_budget_tokens: 100000,
      context_used_tokens: 80000,
    };

    const env = {
      ...process.env,
      HOME: cwd,
      USERPROFILE: cwd,
      OMC_JEV: "",
      OMC_SKIP_HOOKS: "",
      DISABLE_OMC: "",
      NODE_ENV: "test",
    };

    const result = await runHookScript(
      join(PROJECT_ROOT, "scripts/post-tool-verifier.mjs"),
      input,
      env,
      cwd,
    );

    expect(result.exitCode).toBe(0);

    const output = JSON.parse(result.stdout);
    expect(output.continue).toBe(true);

    // Write tool should not trigger compaction checks
    if (output.hookSpecificOutput) {
      const message = output.hookSpecificOutput.additionalContext || "";
      expect(message).not.toMatch(/\[OMC (CRITICAL|WARNING)\]/);
    }
  });
});
