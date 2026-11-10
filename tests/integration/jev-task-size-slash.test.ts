/**
 * OMC_JEV_TASK_SIZE_SLASH_ANYWHERE=1 in scripts/keyword-detector.mjs: a heavy
 * mode typed as a slash command anywhere in the prompt (also /omc:<mode>) is
 * never dropped by the active task-size point. Also covers it together with
 * OMC_JEV_TASK_SIZE_PREFIX_WINS and OMC_JEV_TASK_SIZE_NOTICE. Without the
 * variable the script behaves exactly as before. Real script subprocess
 * against a stub Jev endpoint.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SUPPRESSED = { continue: true, suppressOutput: true };
const RALPH_INVOCATION = "[MAGIC KEYWORD: RALPH]";
// Prompts some tests below expect to lose ralph; the control test checks that
// keyword detection finds ralph in each of them.
const PROMPTS_WITH_RALPH = [
  "use ralph to fix the typo in a/ralph",
  "use ralph to fix the typo in /ralph.md",
  "use ralph to fix the typo\n```\n/ralph\n```",
  "use ralph to fix the typo\n> /ralph was run before",
  "fix the typo and run /oh-my-claudecode:ralph now",
  "/omc:ralph fix the typo",
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

describe("keyword-detector.mjs: OMC_JEV_TASK_SIZE_SLASH_ANYWHERE", () => {
  let cwd: string;
  let env: NodeJS.ProcessEnv;
  let server: Server;
  let status: number;
  let choice: string;
  let confidence: number;
  let taskSizeRequests: number;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "jev-task-size-slash-"));
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
      { prompt, cwd, session_id: "jev-task-size-slash" },
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

  /** The ralph state written by activation, or null when activation did not write one. */
  function persistedRalphState() {
    const file = readdirSync(cwd, { recursive: true, encoding: "utf8" })
      .find((entry) => entry.replace(/\\/g, "/").split("/").pop() === "ralph-state.json");
    return file
      ? JSON.parse(readFileSync(join(cwd, file), "utf8")) as { invocation_source?: string; awaiting_confirmation?: boolean }
      : null;
  }

  /**
   * Ralph was kept and its persisted state records the slash command as the
   * user's confirmation: no awaiting-confirmation window, which would make the
   * Stop hook skip ralph enforcement. Activation may fail under load without
   * the better-sqlite3 binding (see expectModeKept); only then is no state checked.
   */
  function expectConfirmedBySlash(output: Awaited<ReturnType<typeof run>>) {
    const context = output.hookSpecificOutput?.additionalContext ?? "";
    expectModeKept(context, "ralph");
    if (context.includes("No ralph state was activated.")) return;
    const state = persistedRalphState();
    expect(state, "ralph state was not persisted").not.toBeNull();
    expect(state?.invocation_source).toBe("slash");
    expect(state?.awaiting_confirmation).toBeUndefined();
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

    it("a slash command after the start of the prompt does not keep ralph", async () => {
      expect(await run("fix the typo and run /oh-my-claudecode:ralph now")).toEqual(SUPPRESSED);
      expectJevAnswered();
    });

    it("the /omc: alias at the start of the prompt does not keep ralph", async () => {
      expect(await run("/omc:ralph fix the typo")).toEqual(SUPPRESSED);
      expectJevAnswered();
    });

    it("OMC_JEV_TASK_SIZE_SLASH_ANYWHERE=0 is the same as unset", async () => {
      expect(await run("fix the typo and run /oh-my-claudecode:ralph now", { OMC_JEV_TASK_SIZE_SLASH_ANYWHERE: "0" })).toEqual(SUPPRESSED);
      expectJevAnswered();
    });
  });

  describe("with OMC_JEV_TASK_SIZE_SLASH_ANYWHERE=1", () => {
    const SLASH_ANYWHERE = { OMC_JEV_TASK_SIZE_SLASH_ANYWHERE: "1" };

    it.each([
      ["after the start of the prompt", "fix the typo and run /oh-my-claudecode:ralph now"],
      ["followed by punctuation", "fix the typo and run /ralph."],
      ["in brackets", "use ralph to fix the typo (/ralph)"],
      ["through the /omc: alias", "/omc:ralph fix the typo"],
    ])("a slash command %s keeps ralph", async (_label, prompt) => {
      expectConfirmedBySlash(await run(prompt, SLASH_ANYWHERE));
      expectJevAnswered();
    });

    it.each([
      ["autopilot", "fix the typo and run /autopilot now"],
      ["ralplan", "fix the typo and run /omc:ralplan now"],
    ])("a slash command after the start keeps %s", async (mode, prompt) => {
      expectKept(await run(prompt, SLASH_ANYWHERE), mode);
      expectJevAnswered();
    });

    it("accepts true as well as 1", async () => {
      expectConfirmedBySlash(await run("fix the typo and run /oh-my-claudecode:ralph now", { OMC_JEV_TASK_SIZE_SLASH_ANYWHERE: "true" }));
      expectJevAnswered();
    });

    it("a ralph mention in prose kept for a medium answer still awaits confirmation", async () => {
      choice = "medium";
      const context = (await run("use ralph to fix the typo", SLASH_ANYWHERE)).hookSpecificOutput?.additionalContext ?? "";
      expectModeKept(context, "ralph");
      if (context.includes("No ralph state was activated.")) return;
      const state = persistedRalphState();
      expect(state, "ralph state was not persisted").not.toBeNull();
      expect(state?.awaiting_confirmation).toBe(true);
      expect(state?.invocation_source).toBeUndefined();
    });

    it.each([
      ["a mode name inside a path", "use ralph to fix the typo in a/ralph"],
      ["a file name that starts with the mode", "use ralph to fix the typo in /ralph.md"],
      ["a slash command inside a code block", "use ralph to fix the typo\n```\n/ralph\n```"],
      ["a slash command inside a quote", "use ralph to fix the typo\n> /ralph was run before"],
    ])("%s does not keep ralph", async (_label, prompt) => {
      expect(await run(prompt, SLASH_ANYWHERE)).toEqual(SUPPRESSED);
      expectJevAnswered();
    });

    it("does not make a size prefix win on its own", async () => {
      choice = "medium";
      expectKept(await run("quick: use ralph to fix this", SLASH_ANYWHERE));
      expectJevAnswered();
    });
  });

  describe("with OMC_JEV_TASK_SIZE_SLASH_ANYWHERE=1 but no active task-size decision", () => {
    /** Ralph was kept and its persisted state still awaits confirmation (no slash confirmation). */
    function expectAwaitingConfirmation(output: Awaited<ReturnType<typeof run>>) {
      const context = output.hookSpecificOutput?.additionalContext ?? "";
      expectModeKept(context, "ralph");
      if (context.includes("No ralph state was activated.")) return;
      const state = persistedRalphState();
      expect(state, "ralph state was not persisted").not.toBeNull();
      expect(state?.awaiting_confirmation).toBe(true);
      expect(state?.invocation_source).toBeUndefined();
    }

    it.each([
      ["shadow mode", "task-size"],
      ["Jev off", "off"],
    ])("a mid-prompt slash command does not confirm ralph in %s", async (_label, jev) => {
      expectAwaitingConfirmation(await run("fix the typo and run /ralph now", {
        OMC_JEV_TASK_SIZE_SLASH_ANYWHERE: "1",
        OMC_JEV: jev,
      }));
    });
  });

  describe("with OMC_JEV_TASK_SIZE_SLASH_ANYWHERE=1 and OMC_JEV_TASK_SIZE_PREFIX_WINS=1", () => {
    const BOTH = { OMC_JEV_TASK_SIZE_SLASH_ANYWHERE: "1", OMC_JEV_TASK_SIZE_PREFIX_WINS: "1" };

    it("a slash command keeps ralph although a size prefix wins over a medium answer", async () => {
      choice = "medium";
      expectKept(await run("quick: fix the typo and run /ralph now", BOTH));
      expectJevAnswered();
    });

    it("without a slash command the size prefix still drops ralph", async () => {
      choice = "medium";
      expect(await run("quick: use ralph to fix this", BOTH)).toEqual(SUPPRESSED);
      expectJevAnswered();
    });
  });

  describe("with all three task-size variables", () => {
    const ALL = { OMC_JEV_TASK_SIZE_SLASH_ANYWHERE: "1", OMC_JEV_TASK_SIZE_PREFIX_WINS: "1", OMC_JEV_TASK_SIZE_NOTICE: "1" };

    it("the notice says that a slash command anywhere keeps its mode", async () => {
      choice = "medium";
      const context = (await run("quick: use ralph to fix this", ALL)).hookSpecificOutput?.additionalContext ?? "";
      expect(context).toContain("[TASK-SIZE: SMALL] Heavy orchestration mode(s) suppressed: ralph.");
      expect(context).toContain('Reason: size prefix "quick:" (Jev active-mode classification: medium, confidence 0.99)');
      expect(context).toContain("type its slash command anywhere in the prompt");
      expect(context).not.toContain(RALPH_INVOCATION);
    });

    it("does not say Jev rated the task small when a size prefix won over a medium answer", async () => {
      choice = "medium";
      const context = (await run("quick: fix the typo and run /oh-my-claudecode:ralph now", ALL)).hookSpecificOutput?.additionalContext ?? "";
      expect(context).toContain("[TASK-SIZE] Heavy mode(s) kept: ralph (slash command).");
      expect(context).not.toContain("rated this task small");
      expectModeKept(context, "ralph");
    });

    it("names a mode kept by a slash command after the start of the prompt", async () => {
      const context = (await run("fix the typo and run /oh-my-claudecode:ralph now", ALL)).hookSpecificOutput?.additionalContext ?? "";
      expect(context).toContain("[TASK-SIZE] Heavy mode(s) kept although Jev rated this task small: ralph (slash command).");
      expectModeKept(context, "ralph");
    });
  });
});
