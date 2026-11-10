/**
 * Opt-in actions on the advisory Jev points (issue #4928): slop-warning,
 * learner-extraction, simplifier-trigger and the loop-continuation release.
 * Real hook script subprocesses against a local stub of the Jev endpoint.
 * Every variable is off by default; each block also checks that the hook
 * behaves as before without it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

type RunResult = { stdout: string; stderr: string; exitCode: number };

// Keep the test's event loop free: the hook's synchronous Jev child has to be
// able to POST to the HTTP server that runs in this process.
function runScript(
  script: string,
  input: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(PROJECT_ROOT, "scripts", script)], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
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

function findFiles(dir: string, name: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findFiles(path, name));
    else if (entry.name === name) found.push(path);
  }
  return found;
}

describe("jev advisory points: opt-in actions", () => {
  let cwd: string;
  let env: NodeJS.ProcessEnv;
  let server: Server;
  let requests: Array<{ questions: string[]; state: Record<string, unknown> }>;
  // Probability of "yes" by question name; a number or a per-mode map for task_complete.
  let noul: Record<string, number>;
  let noulByMode: Record<string, number>;
  let status: number;
  let onTaskComplete: (() => void) | undefined;
  // Shadow-mode runs leave a detached resolver that writes one log row when it is done.
  let shadowRuns: number;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "jev-advisory-"));
    requests = [];
    noul = {};
    noulByMode = {};
    status = 200;
    onTaskComplete = undefined;
    shadowRuns = 0;
    server = createServer((request, response) => {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        raw += chunk;
      });
      request.on("end", () => {
        const body = JSON.parse(raw) as {
          state: Record<string, unknown>;
          questions: Record<string, unknown>;
        };
        const questions = Object.keys(body.questions);
        requests.push({ questions, state: body.state });
        const question = questions[0];
        if (question === "task_complete") onTaskComplete?.();
        const mode = body.state.mode_name;
        const value =
          typeof mode === "string" && mode in noulByMode ? noulByMode[mode] : noul[question] ?? 0;
        response.writeHead(status, { "Content-Type": "application/json", Connection: "close" });
        response.end(
          JSON.stringify({ answers: { [question]: { type: "noul", noul: value, confidence: 0.9 } } }),
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected local TCP endpoint");
    env = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: cwd,
      USERPROFILE: cwd,
      XDG_CONFIG_HOME: join(cwd, "config"),
      CLAUDE_CONFIG_DIR: join(cwd, "claude"),
      NODE_NO_WARNINGS: "1",
      OMC_DISABLE_MULTIREPO: "1",
      OMC_HOME: join(cwd, "omc-home"),
      OMC_STATE_DIR: join(cwd, ".omc"),
      OMC_JEV_LOG_DIR: join(cwd, "jev-logs"),
      OMC_JEV_QUIET: "1",
      OMC_JEV_TIMEOUT_MS: "3000",
      OMC_PRE_TOOL_ADVISORY_COOLDOWN_MS: "0",
      TYPESAFE_API_KEY: "test-key-123",
      OMC_JEV_ENDPOINT: `http://127.0.0.1:${address.port}/v1/systemone`,
    };
  });

  afterEach(async () => {
    const logPath = join(cwd, "jev-logs", "shadow.jsonl");
    for (let i = 0; i < 100 && shadowRuns > 0; i++) {
      const rows = existsSync(logPath)
        ? readFileSync(logPath, "utf8").split("\n").filter((line) => line.includes('"mode":"shadow"')).length
        : 0;
      if (rows >= shadowRuns) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    // A detached shadow resolver can still hold a file for a moment on Windows.
    rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  describe("slop-warning (OMC_JEV_SLOP_WARNING_APPLY, OMC_JEV_SLOP_WARNING_THRESHOLD)", () => {
    const WORKAROUND = "Add a workaround if the normal architecture is hard.";
    const BENIGN = "Write a unit test for the parser.";

    function slopInput(prompt: string) {
      return {
        cwd,
        tool_name: "Task",
        toolInput: {
          subagent_type: "oh-my-claudecode:executor",
          description: "Implement the change",
          prompt,
        },
      };
    }

    async function warns(prompt: string, extra: NodeJS.ProcessEnv): Promise<boolean> {
      const result = await runScript("pre-tool-enforcer.mjs", slopInput(prompt), { ...env, ...extra }, cwd);
      expect(result.exitCode, result.stderr).toBe(0);
      return result.stdout.includes("SLOP WARNING");
    }

    it("without the variable the heuristic decides, whatever the active answer says", async () => {
      noul.slop_advisory = 0.99;
      expect(await warns(BENIGN, { OMC_JEV: "slop-warning:active" })).toBe(false);
      noul.slop_advisory = 0.01;
      expect(await warns(WORKAROUND, { OMC_JEV: "slop-warning:active" })).toBe(true);
      expect(requests.map((r) => r.questions[0])).toEqual(["slop_advisory", "slop_advisory"]);
    }, 30000);

    it("with the variable an active answer at the threshold warns and one below it silences", async () => {
      const apply = { OMC_JEV: "slop-warning:active", OMC_JEV_SLOP_WARNING_APPLY: "1" };
      noul.slop_advisory = 0.8;
      expect(await warns(BENIGN, apply)).toBe(true);
      noul.slop_advisory = 0.79;
      expect(await warns(WORKAROUND, apply)).toBe(false);
      noul.slop_advisory = 0.95;
      expect(await warns(WORKAROUND, apply)).toBe(true);
    }, 45000);

    it("the threshold variable moves the cut", async () => {
      noul.slop_advisory = 0.6;
      const apply = { OMC_JEV: "slop-warning:active", OMC_JEV_SLOP_WARNING_APPLY: "true" };
      expect(await warns(BENIGN, apply)).toBe(false);
      expect(await warns(BENIGN, { ...apply, OMC_JEV_SLOP_WARNING_THRESHOLD: "0.5" })).toBe(true);
      expect(await warns(BENIGN, { ...apply, OMC_JEV_SLOP_WARNING_THRESHOLD: "0.7" })).toBe(false);
    }, 45000);

    it("an invalid threshold is reported and the default 0.8 is used", async () => {
      const apply = {
        OMC_JEV: "slop-warning:active",
        OMC_JEV_SLOP_WARNING_APPLY: "1",
        OMC_JEV_SLOP_WARNING_THRESHOLD: "banana",
        OMC_JEV_QUIET: "0",
      };
      noul.slop_advisory = 0.85;
      const result = await runScript("pre-tool-enforcer.mjs", slopInput(BENIGN), { ...env, ...apply }, cwd);
      expect(result.stdout).toContain("SLOP WARNING");
      expect(result.stderr).toContain("OMC_JEV_SLOP_WARNING_THRESHOLD=banana");
      noul.slop_advisory = 0.75;
      expect(await warns(BENIGN, apply)).toBe(false);
      for (const bad of ["0", "1.5", "-1"]) {
        noul.slop_advisory = 0.85;
        expect(await warns(BENIGN, { ...apply, OMC_JEV_SLOP_WARNING_THRESHOLD: bad })).toBe(true);
        noul.slop_advisory = 0.75;
        expect(await warns(BENIGN, { ...apply, OMC_JEV_SLOP_WARNING_THRESHOLD: bad })).toBe(false);
      }
    }, 90000);

    it("an HTTP error and plan mode with OMC_JEV_PLAN_MODE=off keep the heuristic", async () => {
      noul.slop_advisory = 0.99;
      status = 500;
      const apply = { OMC_JEV: "slop-warning:active", OMC_JEV_SLOP_WARNING_APPLY: "1" };
      expect(await warns(BENIGN, apply)).toBe(false);
      expect(await warns(WORKAROUND, apply)).toBe(true);
      // Plan mode with OMC_JEV_PLAN_MODE=off sends no request, so the heuristic decides.
      status = 200;
      requests.length = 0;
      const planInput = { ...slopInput(BENIGN), permission_mode: "plan" };
      const result = await runScript(
        "pre-tool-enforcer.mjs",
        planInput,
        { ...env, ...apply, OMC_JEV_PLAN_MODE: "off" },
        cwd,
      );
      expect(result.stdout).not.toContain("SLOP WARNING");
      expect(requests).toHaveLength(0);
    }, 45000);

    it("shadow mode and an unreachable endpoint keep the heuristic even with the variable", async () => {
      noul.slop_advisory = 0.99;
      shadowRuns += 1;
      expect(
        await warns(BENIGN, { OMC_JEV: "slop-warning", OMC_JEV_SLOP_WARNING_APPLY: "1" }),
      ).toBe(false);
      const unreachable = {
        OMC_JEV: "slop-warning:active",
        OMC_JEV_SLOP_WARNING_APPLY: "1",
        OMC_JEV_ENDPOINT: "http://127.0.0.1:9",
      };
      expect(await warns(BENIGN, unreachable)).toBe(false);
      expect(await warns(WORKAROUND, unreachable)).toBe(true);
    }, 45000);
  });

  describe("learner-extraction (OMC_JEV_LEARNER_HINT)", () => {
    const MESSAGE =
      "The issue was caused by a race condition. I fixed it by adding proper locking.";

    function stopInput(sessionId: string) {
      return { cwd, sessionId, directory: cwd, last_assistant_message: MESSAGE };
    }

    async function stop(sessionId: string, extra: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
      const result = await runScript("persistent-mode.mjs", stopInput(sessionId), { ...env, ...extra }, cwd);
      expect(result.exitCode, result.stderr).toBe(0);
      return JSON.parse(result.stdout) as Record<string, unknown>;
    }

    it("without the variable the Stop output is the plain release", async () => {
      noul.extractable_moment = 0.95;
      const output = await stop("sess-learner-off", { OMC_JEV: "learner-extraction:active" });
      expect(output).toEqual({ continue: true, suppressOutput: true });
      expect(requests).toHaveLength(1);
      expect(findFiles(cwd, "jev-learner-hint.json")).toEqual([]);
    }, 20000);

    it("with the variable an active answer of 0.8 or more adds the hint once per session", async () => {
      const hint = { OMC_JEV: "learner-extraction:active", OMC_JEV_LEARNER_HINT: "1" };
      noul.extractable_moment = 0.8;
      const first = await stop("sess-learner-a", hint);
      expect(first).toMatchObject({ continue: true, suppressOutput: true });
      expect(String(first.systemMessage)).toContain("/oh-my-claudecode:remember");
      expect(findFiles(cwd, "jev-learner-hint.json")).toHaveLength(1);

      const again = await stop("sess-learner-a", hint);
      expect(again).toEqual({ continue: true, suppressOutput: true });

      const other = await stop("sess-learner-b", hint);
      expect(String(other.systemMessage)).toContain("/oh-my-claudecode:remember");
      expect(findFiles(cwd, "jev-learner-hint.json")).toHaveLength(2);
    }, 40000);

    it("an answer below 0.8, shadow mode and a degraded call add nothing", async () => {
      noul.extractable_moment = 0.79;
      const below = await stop("sess-learner-low", {
        OMC_JEV: "learner-extraction:active",
        OMC_JEV_LEARNER_HINT: "1",
      });
      expect(below).toEqual({ continue: true, suppressOutput: true });
      expect(requests.map((r) => r.questions[0])).toEqual(["extractable_moment"]);

      noul.extractable_moment = 0.99;
      shadowRuns += 1;
      const shadow = await stop("sess-learner-shadow", {
        OMC_JEV: "learner-extraction",
        OMC_JEV_LEARNER_HINT: "1",
      });
      expect(shadow).toEqual({ continue: true, suppressOutput: true });

      const degraded = await stop("sess-learner-down", {
        OMC_JEV: "learner-extraction:active",
        OMC_JEV_LEARNER_HINT: "1",
        OMC_JEV_ENDPOINT: "http://127.0.0.1:9",
      });
      expect(degraded).toEqual({ continue: true, suppressOutput: true });
      expect(findFiles(cwd, "jev-learner-hint.json")).toEqual([]);
    }, 40000);

    it("a blocked Stop carries no hint and does not use up the session's hint", async () => {
      const sessionId = "sess-learner-block";
      const now = new Date().toISOString();
      const dir = join(cwd, ".omc", "non-git", "state", "sessions", sessionId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "ralph-state.json"),
        JSON.stringify({
          active: true,
          mode: "ralph",
          iteration: 1,
          max_iterations: 5,
          session_id: sessionId,
          project_path: cwd,
          started_at: now,
          last_checked_at: now,
          updated_at: now,
        }),
      );
      noul.extractable_moment = 0.95;
      const output = await stop(sessionId, {
        OMC_JEV: "learner-extraction:active",
        OMC_JEV_LEARNER_HINT: "1",
      });
      expect(output.decision).toBe("block");
      expect(output).not.toHaveProperty("systemMessage");
      expect(requests.map((r) => r.questions[0])).toContain("extractable_moment");
      expect(findFiles(cwd, "jev-learner-hint.json")).toEqual([]);

      // Once the mode is gone, the next Stop of the same session shows the hint.
      rmSync(join(dir, "ralph-state.json"), { force: true });
      const later = await stop(sessionId, {
        OMC_JEV: "learner-extraction:active",
        OMC_JEV_LEARNER_HINT: "1",
      });
      expect(String(later.systemMessage)).toContain("/oh-my-claudecode:remember");
    }, 40000);
  });

  describe("simplifier-trigger (OMC_JEV_SIMPLIFIER_APPLY)", () => {
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
        { cwd, stdio: "pipe" },
      );

    beforeEach(() => {
      execFileSync("git", ["init", "-q"], { cwd, stdio: "pipe" });
      mkdirSync(env.OMC_HOME as string, { recursive: true });
      writeFileSync(
        join(env.OMC_HOME as string, "config.json"),
        JSON.stringify({ codeSimplifier: { enabled: true } }),
      );
      writeFileSync(join(cwd, "app.ts"), "export const a = 1;\n");
      git("add", "app.ts");
      git("commit", "-q", "-m", "init");
      writeFileSync(join(cwd, "app.ts"), "export const a = 2;\n");
    });

    async function stop(extra: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
      const result = await runScript(
        "code-simplifier.mjs",
        { cwd, session_id: "sess-simplifier" },
        { ...env, ...extra },
        cwd,
      );
      expect(result.exitCode, result.stderr).toBe(0);
      return JSON.parse(result.stdout) as Record<string, unknown>;
    }

    it("without the variable the reminder is sent whatever the active answer says", async () => {
      noul.simplification_worthy = 0.01;
      const output = await stop({ OMC_JEV: "simplifier-trigger:active" });
      expect(output.decision).toBe("block");
      expect(String(output.reason)).toContain("[CODE SIMPLIFIER]");
      expect(requests).toHaveLength(1);
    }, 20000);

    it("with the variable an active answer below 0.5 skips the reminder and writes no marker", async () => {
      const apply = { OMC_JEV: "simplifier-trigger:active", OMC_JEV_SIMPLIFIER_APPLY: "1" };
      noul.simplification_worthy = 0.49;
      expect(await stop(apply)).toEqual({ continue: true });
      expect(findFiles(cwd, "code-simplifier-triggered.marker")).toEqual([]);
      // The next Stop asks again and can send the reminder.
      noul.simplification_worthy = 0.5;
      const output = await stop(apply);
      expect(output.decision).toBe("block");
      expect(requests).toHaveLength(2);
    }, 40000);

    it("shadow mode and a degraded call keep the reminder", async () => {
      noul.simplification_worthy = 0.01;
      const shadow = await stop({ OMC_JEV: "simplifier-trigger", OMC_JEV_SIMPLIFIER_APPLY: "1" });
      expect(shadow.decision).toBe("block");
      rmSync(join(cwd, ".omc"), { recursive: true, force: true });
      const degraded = await stop({
        OMC_JEV: "simplifier-trigger:active",
        OMC_JEV_SIMPLIFIER_APPLY: "1",
        OMC_JEV_ENDPOINT: "http://127.0.0.1:9",
      });
      expect(degraded.decision).toBe("block");
    }, 40000);
  });

  describe("loop-continuation release (OMC_JEV_LOOP_RELEASE_ONLY)", () => {
    function state(mode: "ralph" | "autopilot", sessionId: string, overrides: Record<string, unknown> = {}) {
      const now = new Date().toISOString();
      return {
        active: true,
        mode,
        ...(mode === "ralph"
          ? { iteration: 1, max_iterations: 5 }
          : { phase: "qa", current_phase: "qa", reinforcement_count: 0 }),
        session_id: sessionId,
        project_path: cwd,
        started_at: now,
        last_checked_at: now,
        updated_at: now,
        ...overrides,
      };
    }

    function write(sessionId: string, file: string, content: Record<string, unknown>): string {
      const dir = join(cwd, ".omc", "non-git", "state", "sessions", sessionId);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, file);
      writeFileSync(path, JSON.stringify(content, null, 2));
      return path;
    }

    const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

    async function stop(sessionId: string, extra: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
      const result = await runScript(
        "persistent-mode.mjs",
        { cwd, sessionId, directory: cwd, last_assistant_message: "The implementation is complete." },
        { ...env, OMC_JEV: "loop-continuation:active", ...extra },
        cwd,
      );
      expect(result.exitCode, result.stderr).toBe(0);
      const output = JSON.parse(result.stdout) as Record<string, unknown>;
      if ("decision" in output) expect(["approve", "block"]).toContain(output.decision);
      return output;
    }

    it("releases a Ralph Stop and leaves the mode active, then asks again at the next Stop", async () => {
      const sessionId = "sess-release-ralph";
      const path = write(sessionId, "ralph-state.json", state("ralph", sessionId));
      noul.task_complete = 0.95;

      const first = await stop(sessionId, { OMC_JEV_LOOP_RELEASE_ONLY: "1" });
      expect(first).not.toHaveProperty("decision");
      expect(first).toMatchObject({ continue: true, suppressOutput: true });
      expect(String(first.systemMessage)).toContain("[JEV-COMPLETION]");
      expect(String(first.systemMessage)).toContain("ralph mode stays active");
      expect(String(first.systemMessage)).toContain("/oh-my-claudecode:cancel");
      expect(read(path)).toMatchObject({ active: true, iteration: 2 });
      expect(read(path)).not.toHaveProperty("completed_at");
      expect(read(path).phase).not.toBe("complete");

      const second = await stop(sessionId, { OMC_JEV_LOOP_RELEASE_ONLY: "true" });
      expect(String(second.systemMessage)).toContain("ralph mode stays active");
      expect(read(path)).toMatchObject({ active: true, iteration: 3 });
      expect(requests.map((r) => r.questions[0])).toEqual(["task_complete", "task_complete"]);

      noul.task_complete = 0.2;
      const third = await stop(sessionId, { OMC_JEV_LOOP_RELEASE_ONLY: "1" });
      expect(third.decision).toBe("block");
      expect(read(path)).toMatchObject({ active: true, iteration: 4 });
    }, 60000);

    it("releases silently when cancel removes the state while Jev is answering", async () => {
      const sessionId = "sess-release-cancel";
      const path = write(sessionId, "ralph-state.json", state("ralph", sessionId));
      noul.task_complete = 0.95;
      onTaskComplete = () => rmSync(path, { force: true });
      const output = await stop(sessionId, { OMC_JEV_LOOP_RELEASE_ONLY: "1" });
      expect(output).toEqual({ continue: true, suppressOutput: true });
      expect(existsSync(path)).toBe(false);
    }, 20000);

    it("without the variable a complete answer still completes the mode", async () => {
      const sessionId = "sess-release-off";
      const path = write(sessionId, "ralph-state.json", state("ralph", sessionId));
      noul.task_complete = 0.95;
      const output = await stop(sessionId, {});
      expect(String(output.systemMessage)).toContain("ralph mode exited");
      expect(read(path)).toMatchObject({ active: false, phase: "complete" });
    }, 20000);

    it("releases at the iteration limit without completing the extended mode", async () => {
      const sessionId = "sess-release-extend";
      const path = write(
        sessionId,
        "ralph-state.json",
        state("ralph", sessionId, { iteration: 3, max_iterations: 3 }),
      );
      noul.task_complete = 0.95;
      const output = await stop(sessionId, { OMC_JEV_LOOP_RELEASE_ONLY: "1" });
      expect(String(output.systemMessage)).toContain("ralph mode stays active");
      expect(read(path)).toMatchObject({ active: true, max_iterations: 13 });
      expect(read(path).phase).not.toBe("complete");
    }, 20000);

    it("releases an autopilot Stop and keeps its reinforcement count", async () => {
      const sessionId = "sess-release-autopilot";
      const path = write(sessionId, "autopilot-state.json", state("autopilot", sessionId));
      noul.task_complete = 0.95;
      const output = await stop(sessionId, { OMC_JEV_LOOP_RELEASE_ONLY: "1" });
      expect(String(output.systemMessage)).toContain("autopilot mode stays active");
      expect(read(path)).toMatchObject({ active: true, phase: "qa", reinforcement_count: 1 });
    }, 20000);

    it("a released child Ralph hands the Stop to the active autopilot", async () => {
      const sessionId = "sess-release-parent";
      const ralphPath = write(sessionId, "ralph-state.json", state("ralph", sessionId));
      const autopilotPath = write(sessionId, "autopilot-state.json", state("autopilot", sessionId));
      noulByMode = { ralph: 0.95, autopilot: 0.2 };
      const output = await stop(sessionId, { OMC_JEV_LOOP_RELEASE_ONLY: "1" });
      expect(output.decision).toBe("block");
      expect(String(output.reason)).toContain("[AUTOPILOT - Phase: qa]");
      expect(read(ralphPath)).toMatchObject({ active: true });
      expect(read(autopilotPath)).toMatchObject({ active: true, reinforcement_count: 1 });
    }, 20000);
  });
});
