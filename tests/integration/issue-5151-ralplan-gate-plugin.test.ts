/**
 * Issue #5151: ralplan gate for plugin hook (keyword-detector.mjs)
 * Tests that vague prompts like "ralph fix this" and "autopilot build the app"
 * are redirected to ralplan in the plugin hook, not just in the bridge.
 */
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function runKeywordDetector(input: Record<string, unknown>, env: NodeJS.ProcessEnv, cwd: string) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
    const child = spawn(process.execPath, [join(PROJECT_ROOT, "scripts", "keyword-detector.mjs")], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ stdout, stderr, exitCode: code ?? 1 }); });
    child.stdin.on("error", reject);
    child.stdin.end(JSON.stringify(input));
  });
}

describe("issue #5151: ralplan gate in plugin hook (keyword-detector.mjs)", () => {
  let cwd: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "issue-5151-"));
    // No inherited hook controls, credentials or workspace.
    env = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: cwd,
      USERPROFILE: cwd,
      XDG_CONFIG_HOME: join(cwd, "config"),
      CLAUDE_CONFIG_DIR: join(cwd, "claude"),
      NODE_NO_WARNINGS: "1",
      OMC_DISABLE_MULTIREPO: "1",
      OMC_STATE_DIR: join(cwd, ".omc"),
    };
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function input(prompt: string) {
    return { prompt, cwd, session_id: "test-sess-5151" };
  }

  async function run(prompt: string, extraEnv: NodeJS.ProcessEnv = {}) {
    const result = await runKeywordDetector(input(prompt), { ...env, ...extraEnv }, cwd);
    expect(result.exitCode, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as {
      continue: boolean;
      suppressOutput?: boolean;
      hookSpecificOutput?: { additionalContext: string };
    };
  }

  function expectKeywordInContext(context: string, keyword: string) {
    const keywordRegex = new RegExp(`\\[MAGIC KEYWORDS? DETECTED:[^\\]]*\\b${keyword}\\b`, "i");
    const invoked = keywordRegex.test(context) || context.includes(`[MAGIC KEYWORD: ${keyword.toUpperCase()}]`);
    expect(invoked || context.includes(`No ${keyword} state was activated.`), context.slice(0, 500)).toBe(true);
  }

  function expectKeywordNotInContext(context: string, keyword: string) {
    const keywordRegex = new RegExp(`\\[MAGIC KEYWORDS? DETECTED:[^\\]]*\\b${keyword}\\b`, "i");
    const invoked = keywordRegex.test(context) || context.includes(`[MAGIC KEYWORD: ${keyword.toUpperCase()}]`);
    expect(invoked, `Keyword ${keyword} should not be in context: ${context.slice(0, 300)}`).toBe(false);
  }

  it("should redirect vague 'ralph fix this' to ralplan", async () => {
    const result = await run("ralph fix this");
    const context = result.hookSpecificOutput?.additionalContext || "";
    expectKeywordInContext(context, "ralplan");
    expectKeywordNotInContext(context, "ralph");
  });

  it("should redirect vague 'autopilot build the app' to ralplan", async () => {
    const result = await run("autopilot build the app");
    const context = result.hookSpecificOutput?.additionalContext || "";
    expectKeywordInContext(context, "ralplan");
    expectKeywordNotInContext(context, "autopilot");
  });

  it("should redirect vague 'ultragoal do something' to ralplan", async () => {
    const result = await run("ultragoal do something");
    const context = result.hookSpecificOutput?.additionalContext || "";
    expectKeywordInContext(context, "ralplan");
    expectKeywordNotInContext(context, "ultragoal");
  });

  it("should NOT redirect well-specified 'ralph fix the bug in src/auth.ts' to ralplan", async () => {
    const result = await run("ralph fix the bug in src/auth.ts");
    const context = result.hookSpecificOutput?.additionalContext || "";
    expectKeywordInContext(context, "ralph");
    expectKeywordNotInContext(context, "ralplan");
  });

  it("should NOT redirect 'force: ralph fix this' to ralplan", async () => {
    const result = await run("force: ralph fix this");
    const context = result.hookSpecificOutput?.additionalContext || "";
    expectKeywordInContext(context, "ralph");
    expectKeywordNotInContext(context, "ralplan");
  });

  it("should NOT redirect '! ralph fix this' to ralplan", async () => {
    const result = await run("! ralph fix this");
    const context = result.hookSpecificOutput?.additionalContext || "";
    expectKeywordInContext(context, "ralph");
    expectKeywordNotInContext(context, "ralplan");
  });

  it("should NOT redirect well-specified 'autopilot implement the getUserById function'", async () => {
    const result = await run("autopilot implement the getUserById function");
    const context = result.hookSpecificOutput?.additionalContext || "";
    expectKeywordInContext(context, "autopilot");
    expectKeywordNotInContext(context, "ralplan");
  });

  it("should NOT redirect 'ralph' when issue reference is present", async () => {
    const result = await run("ralph fix #1234");
    const context = result.hookSpecificOutput?.additionalContext || "";
    expectKeywordInContext(context, "ralph");
    expectKeywordNotInContext(context, "ralplan");
  });

  it("should preserve non-execution keywords when gating", async () => {
    const result = await run("ralph tdd fix this");
    const context = result.hookSpecificOutput?.additionalContext || "";
    expectKeywordInContext(context, "ralplan");
    expectKeywordInContext(context, "tdd");
    expectKeywordNotInContext(context, "ralph");
  });

  it("should NOT gate when ralplan is already present", async () => {
    const result = await run("ralplan ralph fix this");
    const context = result.hookSpecificOutput?.additionalContext || "";
    expectKeywordInContext(context, "ralplan");
    // ralph might be in the context if gate didn't apply (which is correct)
  });

  it("should handle multiple execution keywords", async () => {
    const result = await run("ralph autopilot fix it");
    const context = result.hookSpecificOutput?.additionalContext || "";
    expectKeywordInContext(context, "ralplan");
    expectKeywordNotInContext(context, "ralph");
    expectKeywordNotInContext(context, "autopilot");
  });

  it("should redirect 'ralph implement it' (vague) to ralplan", async () => {
    const result = await run("ralph implement it");
    const context = result.hookSpecificOutput?.additionalContext || "";
    expectKeywordInContext(context, "ralplan");
    expectKeywordNotInContext(context, "ralph");
  });
});
