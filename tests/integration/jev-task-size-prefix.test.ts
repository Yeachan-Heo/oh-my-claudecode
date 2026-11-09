/**
 * OMC_JEV_TASK_SIZE_PREFIX_WINS=1 in scripts/keyword-detector.mjs: a size
 * prefix of the classifier makes the active task-size point drop heavy modes
 * whatever size Jev answers. Without the variable the script behaves exactly
 * as before. Real script subprocess against a stub Jev endpoint.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SUPPRESSED = { continue: true, suppressOutput: true };
const RALPH_INVOCATION = "[MAGIC KEYWORD: RALPH]";
// Prompts the tests below expect to lose ralph with the variable set; the
// control test checks that keyword detection finds ralph in each of them.
const PROMPTS_WITH_RALPH = [
  "quick: use ralph to fix this",
  "only: use ralph to fix this",
  "simple: use ralph to fix this",
];

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

describe("keyword-detector.mjs: OMC_JEV_TASK_SIZE_PREFIX_WINS", () => {
  let cwd: string;
  let env: NodeJS.ProcessEnv;
  let server: Server;
  let status: number;
  let choice: string;
  let confidence: number;
  let taskSizeRequests: number;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "jev-task-size-prefix-"));
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

  async function run(prompt: string, extraEnv: NodeJS.ProcessEnv = {}) {
    const result = await runKeywordDetector(
      { prompt, cwd, session_id: "jev-task-size-prefix" },
      { ...env, ...extraEnv },
      cwd,
    );
    expect(result.exitCode, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as {
      continue: boolean;
      suppressOutput?: boolean;
      hookSpecificOutput?: { additionalContext: string };
    };
  }

  function taskSizeModes() {
    return readFileSync(join(cwd, "jev-logs", "shadow.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { point: string; mode: string })
      .filter((entry) => entry.point === "task-size")
      .map((entry) => entry.mode);
  }

  function expectKept(output: Awaited<ReturnType<typeof run>>, mode = "ralph") {
    expectModeKept(output.hookSpecificOutput?.additionalContext ?? "", mode);
  }

  /** Jev answered in active mode (not degraded), so a kept mode was kept by the rule under test. */
  function expectJevAnswered() {
    expect(taskSizeRequests).toBe(1);
    expect(taskSizeModes()).toEqual(["active"]);
  }

  describe("without the variable (unchanged)", () => {
    it.each(PROMPTS_WITH_RALPH)("control: ralph is detected and kept for a medium answer in %j", async (prompt) => {
      choice = "medium";
      expectKept(await run(prompt));
      expectJevAnswered();
    });

    it("a classifier size prefix does not drop ralph when Jev's small has a confidence below 0.9", async () => {
      confidence = 0.5;
      expectKept(await run("quick: use ralph to fix this"));
      expectJevAnswered();
    });

    it("OMC_JEV_TASK_SIZE_PREFIX_WINS=0 is the same as unset", async () => {
      choice = "medium";
      expectKept(await run("quick: use ralph to fix this", { OMC_JEV_TASK_SIZE_PREFIX_WINS: "0" }));
      expectJevAnswered();
    });
  });

  describe("with OMC_JEV_TASK_SIZE_PREFIX_WINS=1", () => {
    const PREFIX_WINS = { OMC_JEV_TASK_SIZE_PREFIX_WINS: "1" };

    it.each(["medium", "large"])("a classifier size prefix drops ralph when Jev answers %s", async (size) => {
      choice = size;
      expect(await run("quick: use ralph to fix this", PREFIX_WINS)).toEqual(SUPPRESSED);
      expectJevAnswered();
    });

    it("a classifier size prefix drops ralph when Jev's small has a confidence below 0.9", async () => {
      confidence = 0.5;
      expect(await run("only: use ralph to fix this", PREFIX_WINS)).toEqual(SUPPRESSED);
    });

    it("accepts true as well as 1", async () => {
      choice = "medium";
      expect(await run("simple: use ralph to fix this", { OMC_JEV_TASK_SIZE_PREFIX_WINS: "true" })).toEqual(SUPPRESSED);
    });

    it("a prefix the classifier does not know still needs Jev small with confidence >= 0.9", async () => {
      choice = "medium";
      expectKept(await run("urgent: use ralph to fix this", PREFIX_WINS));
      expectJevAnswered();
    });

    it("does not keep a slash command after the start of the prompt on its own", async () => {
      choice = "medium";
      expect(await run("quick: fix the typo and run /ralph now", PREFIX_WINS)).toEqual(SUPPRESSED);
      expectJevAnswered();
    });

    it("drops nothing when the Jev call degrades", async () => {
      status = 500;
      expectKept(await run("quick: use ralph to fix this", PREFIX_WINS));
      expect(taskSizeRequests).toBe(1);
      expect(taskSizeModes()).toEqual(["degraded"]);
    });

    it("drops nothing in shadow mode", async () => {
      choice = "medium";
      expectKept(await run("quick: use ralph to fix this", { ...PREFIX_WINS, OMC_JEV: "task-size" }));
      // The shadow resolver is detached: wait for its line before the workspace is removed.
      await vi.waitFor(() => expect(taskSizeModes()).toEqual(["shadow"]), { timeout: 10000, interval: 50 });
    });

    it("drops nothing when the task-size point is not opted in", async () => {
      expectKept(await run("quick: use ralph to fix this", { ...PREFIX_WINS, OMC_JEV: "" }));
      expect(taskSizeRequests).toBe(0);
    });

    it("drops nothing when task-size suppression is turned off in the config", async () => {
      choice = "medium";
      mkdirSync(join(cwd, ".claude"), { recursive: true });
      writeFileSync(join(cwd, ".claude", "omc.jsonc"), JSON.stringify({ taskSizeDetection: { suppressHeavyModesForSmallTasks: false } }));
      expectKept(await run("quick: use ralph to fix this", PREFIX_WINS));
      expectJevAnswered();
    });
  });

  describe("with OMC_JEV_TASK_SIZE_PREFIX_WINS=1 and OMC_JEV_TASK_SIZE_NOTICE=1", () => {
    it("names the size prefix as the reason when it won over a medium answer", async () => {
      choice = "medium";
      const output = await run("quick: use ralph to fix this", { OMC_JEV_TASK_SIZE_PREFIX_WINS: "1", OMC_JEV_TASK_SIZE_NOTICE: "1" });
      const context = output.hookSpecificOutput?.additionalContext ?? "";
      expect(context).toContain("[TASK-SIZE: SMALL] Heavy orchestration mode(s) suppressed: ralph.");
      expect(context).toContain('Reason: size prefix "quick:" (Jev active-mode classification: medium, confidence 0.99)');
      expect(context).toContain("start the prompt with its slash command");
      expect(context).not.toContain(RALPH_INVOCATION);
    });
  });
});
