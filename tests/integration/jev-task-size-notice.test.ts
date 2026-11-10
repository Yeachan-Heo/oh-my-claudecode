/**
 * OMC_JEV_TASK_SIZE_NOTICE=1 in scripts/keyword-detector.mjs: the task-size
 * outcome is reported in additionalContext, as the TypeScript bridge does for
 * suppressed modes, and the classifier agreement check uses the
 * taskSizeDetection word limits. Without the variable the script behaves
 * exactly as before. Real script subprocess against a stub Jev endpoint.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SUPPRESSED_NOTE = "[TASK-SIZE: SMALL] Heavy orchestration mode(s) suppressed:";
const KEPT_NOTE = "[TASK-SIZE] Heavy mode(s) kept although Jev rated this task small:";
const RALPH_INVOCATION = "[MAGIC KEYWORD: RALPH]";
// 66 words, no size signals: the default classifier rates it medium.
const MEDIUM_PROMPT =
  "Please use ralph to update the greeting text shown on the landing page so that it mentions the new opening hours " +
  "and the holiday schedule, then check that the footer still lists the correct phone number and email address for " +
  "the support staff, and finally make sure the page title matches the wording our marketing colleagues approved " +
  "last week in the meeting with the design group.";

/**
 * The heavy mode survived the task-size step: its skill invocation is in the
 * context, or its state activation ran and failed. Activation runs only for
 * modes that are still resolved, and on machines without the better-sqlite3
 * binding the file-lock fallback can fail under load ("No ralph state was
 * activated."), which says nothing about the task-size rules under test.
 */
function expectModeKept(context: string, mode: string) {
  const name = mode.toUpperCase();
  const invoked = context.includes(`[MAGIC KEYWORD: ${name}]`) ||
    new RegExp(`\\[MAGIC KEYWORDS DETECTED: [^\\]]*\\b${name}\\b`).test(context);
  expect(invoked || context.includes(`No ${mode} state was activated.`), context.slice(0, 300)).toBe(true);
}

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

describe("keyword-detector.mjs: OMC_JEV_TASK_SIZE_NOTICE", () => {
  let cwd: string;
  let env: NodeJS.ProcessEnv;
  let server: Server;
  let status: number;
  let choice: string;
  let confidence: number | undefined;
  let taskSizeRequests: number;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "jev-task-size-notice-"));
    status = 200;
    choice = "small";
    confidence = 0.99;
    taskSizeRequests = 0;
    server = createServer((request, response) => {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { raw += chunk; });
      request.on("end", () => {
        const body = JSON.parse(raw) as { questions: Record<string, { type: string }> };
        const question = Object.keys(body.questions)[0];
        if (question === "task-size") taskSizeRequests += 1;
        const answer = body.questions[question].type === "noul"
          ? { type: "noul", noul: 0, confidence }
          : { type: "choice", choice, confidence };
        response.writeHead(status, { "Content-Type": "application/json", Connection: "close" });
        response.end(JSON.stringify(status === 200 ? { answers: { [question]: answer } } : {}));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected local TCP endpoint");
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
      OMC_JEV_LOG_DIR: join(cwd, "jev-logs"),
      OMC_JEV_QUIET: "1",
      OMC_JEV_TIMEOUT_MS: "5000",
      TYPESAFE_API_KEY: "test-key-123",
      OMC_JEV_ENDPOINT: `http://127.0.0.1:${address.port}/v1/systemone`,
      OMC_JEV: "task-size:active",
    };
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    rmSync(cwd, { recursive: true, force: true });
  });

  function input(prompt: string) {
    return { prompt, cwd, session_id: "test-sess-task-size-notice" };
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

  function writeProjectConfig(taskSizeDetection: Record<string, unknown>) {
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "omc.jsonc"), JSON.stringify({ taskSizeDetection }));
  }

  function taskSizeLog() {
    return readFileSync(join(cwd, "jev-logs", "shadow.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { point: string; mode: string; heuristic: unknown; jev: unknown })
      .filter((entry) => entry.point === "task-size");
  }

  /** Jev answered in active mode (not degraded), so the outcome comes from the rule under test. */
  function expectJevAnswered() {
    expect(taskSizeRequests).toBe(1);
    const entries = taskSizeLog();
    expect(entries.map((entry) => entry.mode)).toEqual(["active"]);
    expect(entries[0].jev).not.toBeNull();
  }

  describe("without the variable (unchanged)", () => {
    it("suppresses silently", async () => {
      const output = await run("Please use ralph and autopilot to fix this.");
      expect(output).toEqual({ continue: true, suppressOutput: true });
      expectJevAnswered();
    });

    it("keeps a low-confidence small answer's heavy mode without a note", async () => {
      confidence = 0.5;
      const output = await run("Please use ralph to fix this.");
      expectModeKept(output.hookSpecificOutput?.additionalContext ?? "", "ralph");
      expect(output.hookSpecificOutput?.additionalContext).not.toContain("[TASK-SIZE");
      expectJevAnswered();
    });

    it("ignores the taskSizeDetection word limits", async () => {
      writeProjectConfig({ smallWordLimit: 3 });
      const output = await run("Please use ralph to fix this.");
      expect(output).toEqual({ continue: true, suppressOutput: true });
      expect(taskSizeLog().map((entry) => entry.heuristic)).toEqual(["small"]);
    });

    it("OMC_JEV_TASK_SIZE_NOTICE=0 is the same as unset", async () => {
      const output = await run("Please use ralph and autopilot to fix this.", { OMC_JEV_TASK_SIZE_NOTICE: "0" });
      expect(output).toEqual({ continue: true, suppressOutput: true });
      expectJevAnswered();
    });
  });

  describe("with OMC_JEV_TASK_SIZE_NOTICE=1", () => {
    const NOTICE = { OMC_JEV_TASK_SIZE_NOTICE: "1" };

    it("announces suppressed heavy modes with the reason", async () => {
      const output = await run("Please use ralph and autopilot to fix this.", NOTICE);
      const context = output.hookSpecificOutput?.additionalContext ?? "";
      expect(context).toContain(`${SUPPRESSED_NOTE} ralph, autopilot.`);
      expect(context).toContain("Reason: Jev active-mode classification: small (confidence 0.99); heuristic: Prompt length (8 words) is within small task threshold (50)");
      expect(context).toContain("`/oh-my-claudecode:ralph`");
      expect(context).not.toContain(KEPT_NOTE);
      expect(context).not.toContain(RALPH_INVOCATION);
    });

    it("names a size prefix as the reason when the classifier does not rate the task small", async () => {
      const output = await run(`fast: ${MEDIUM_PROMPT}`, NOTICE);
      const context = output.hookSpecificOutput?.additionalContext ?? "";
      expect(context).toContain(`${SUPPRESSED_NOTE} ralph.`);
      expect(context).toContain("Reason: Jev active-mode classification: small (confidence 0.99); size prefix in the prompt");
    });

    it("keeps the other parts of the context next to the note", async () => {
      const output = await run("Please use ralph and tdd to fix this.", NOTICE);
      const context = output.hookSpecificOutput?.additionalContext ?? "";
      expect(context).toContain(`${SUPPRESSED_NOTE} ralph.`);
      expect(context).toContain("[TDD MODE ACTIVATED]");
      expect(context).not.toContain(RALPH_INVOCATION);
    });

    it("accepts true as well as 1", async () => {
      const output = await run("Please use ralph and autopilot to fix this.", { OMC_JEV_TASK_SIZE_NOTICE: "true" });
      expect(output.hookSpecificOutput?.additionalContext).toContain(`${SUPPRESSED_NOTE} ralph, autopilot.`);
    });

    it("names a heavy mode kept because Jev's confidence is below 0.9", async () => {
      confidence = 0.5;
      const output = await run("Please use ralph to fix this.", NOTICE);
      const context = output.hookSpecificOutput?.additionalContext ?? "";
      expect(context).toContain(`${KEPT_NOTE} ralph (Jev confidence 0.5 is below 0.9).`);
      expectModeKept(context, "ralph");
      expect(context).not.toContain(SUPPRESSED_NOTE);
    });

    it("names a heavy mode kept because Jev gave no confidence", async () => {
      confidence = undefined;
      const output = await run("Please use ralph to fix this.", NOTICE);
      expect(output.hookSpecificOutput?.additionalContext).toContain(`${KEPT_NOTE} ralph (Jev gave no confidence).`);
    });

    it("names a heavy mode kept because it was invoked as a slash command", async () => {
      const output = await run("/oh-my-claudecode:ralph fix typo", NOTICE);
      expect(output.hookSpecificOutput?.additionalContext).toContain(`${KEPT_NOTE} ralph (slash command).`);
    });

    it("names a heavy mode kept because the heuristic does not rate the task small", async () => {
      const output = await run(MEDIUM_PROMPT, NOTICE);
      expect(taskSizeLog().map((entry) => entry.heuristic)).toEqual(["medium"]);
      expect(output.hookSpecificOutput?.additionalContext).toContain(
        `${KEPT_NOTE} ralph (the heuristic rates the task medium and the prompt has no size prefix).`,
      );
    });

    it("uses the taskSizeDetection word limits for the classifier check, not for the logged heuristic", async () => {
      writeProjectConfig({ smallWordLimit: 3 });
      const output = await run("Please use ralph to fix this.", NOTICE);
      expect(taskSizeLog().map((entry) => entry.heuristic)).toEqual(["small"]);
      expect(output.hookSpecificOutput?.additionalContext).toContain(
        `${KEPT_NOTE} ralph (the heuristic rates the task medium and the prompt has no size prefix).`,
      );
    });

    it("covers the configured largeWordLimit in the classifier check", async () => {
      writeProjectConfig({ largeWordLimit: 50 });
      const output = await run(MEDIUM_PROMPT, NOTICE);
      expect(taskSizeLog().map((entry) => entry.heuristic)).toEqual(["medium"]);
      expect(output.hookSpecificOutput?.additionalContext).toContain(
        `${KEPT_NOTE} ralph (the heuristic rates the task medium and the prompt has no size prefix).`,
      );
      expectModeKept(output.hookSpecificOutput?.additionalContext ?? "", "ralph");
    });

    it("adds no note when Jev does not rate the task small", async () => {
      choice = "large";
      const output = await run("Please use ralph to fix this.", NOTICE);
      const context = output.hookSpecificOutput?.additionalContext ?? "";
      expectModeKept(context, "ralph");
      expect(context).not.toContain("[TASK-SIZE");
      expectJevAnswered();
    });

    it.each([
      ["suppressHeavyModesForSmallTasks: false", { suppressHeavyModesForSmallTasks: false }],
      ["enabled: false", { enabled: false }],
    ])("adds no note with %s in the config", async (_label, config) => {
      writeProjectConfig(config);
      const output = await run("Please use ralph to fix this.", NOTICE);
      const context = output.hookSpecificOutput?.additionalContext ?? "";
      expectModeKept(context, "ralph");
      expect(context).not.toContain("[TASK-SIZE");
      expectJevAnswered();
    });

    it("adds no note in shadow mode", async () => {
      const output = await run("Please use ralph to fix this.", { ...NOTICE, OMC_JEV: "task-size" });
      const context = output.hookSpecificOutput?.additionalContext ?? "";
      expectModeKept(context, "ralph");
      expect(context).not.toContain("[TASK-SIZE");
      // The shadow resolver is detached: wait for its line before the workspace is removed.
      await vi.waitFor(() => expect(taskSizeLog().map((entry) => entry.mode)).toEqual(["shadow"]), { timeout: 10000, interval: 50 });
    });

    it("adds no note when the Jev call degrades", async () => {
      status = 500;
      const output = await run("Please use ralph to fix this.", NOTICE);
      const context = output.hookSpecificOutput?.additionalContext ?? "";
      expectModeKept(context, "ralph");
      expect(context).not.toContain("[TASK-SIZE");
      expect(taskSizeLog().map((entry) => entry.mode)).toEqual(["degraded"]);
    });

    it("adds no note when the task-size point is not opted in", async () => {
      const output = await run("Please use ralph and autopilot to fix this.", { ...NOTICE, OMC_JEV: "" });
      const context = output.hookSpecificOutput?.additionalContext ?? "";
      expectModeKept(context, "ralph");
      expectModeKept(context, "autopilot");
      expect(context).not.toContain("[TASK-SIZE");
      expect(taskSizeRequests).toBe(0);
    });
  });
});
