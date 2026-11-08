/** Real script subprocess regressions for issue #4208. */
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const API_KEY = "test-key-123";

type WireRequest = {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: {
    model: string;
    state: Record<string, unknown>;
    questions: Record<
      string,
      { type: string; instructions: string; criteria: Record<string, string> }
    >;
  };
};

// Keep the test's event loop free: the real hook's synchronous Jev child must
// be able to POST to the HTTP server running in this process.
async function runScript(
  script: string,
  input: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  cwd: string,
) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        [join(PROJECT_ROOT, "scripts", script)],
        {
          cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
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
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        const result = { stdout, stderr, exitCode: code ?? 1 };
        console.log("[jev repro subprocess]", {
          script,
          mode: env.OMC_JEV,
          signal,
          ...result,
        });
        resolve(result);
      });
      child.stdin.on("error", reject);
      child.stdin.end(JSON.stringify(input));
    },
  );
}

describe("jev active-mode subprocess repro", () => {
  let cwd: string;
  let env: NodeJS.ProcessEnv;
  let server: Server;
  let requests: WireRequest[];
  let status: number;
  let choice: string;
  let responseDelayMs: number;
  let noulAnswer: boolean | number;  // Can be boolean for old tests or probability (0-1) for realistic tests
  let noulAnswerByMode: Record<string, boolean | number>;
  let confidenceAnswer: number;
  let onTaskCompleteRequest: (() => void) | undefined;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "jev-active-repro-"));
    requests = [];
    status = 200;
    choice = "opus";
    responseDelayMs = 0;
    noulAnswer = false;
    noulAnswerByMode = {};
    confidenceAnswer = 0.99;
    onTaskCompleteRequest = undefined;
    server = createServer((request, response) => {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        raw += chunk;
      });
      request.on("end", () => {
        const body = JSON.parse(raw) as WireRequest["body"];
        const entry = {
          method: request.method,
          url: request.url,
          headers: request.headers,
          body,
        };
        requests.push(entry);
        console.log("[jev repro request]", entry);
        const question = Object.keys(body.questions)[0];
        if (question === "task_complete") onTaskCompleteRequest?.();
        const modeName = body.state.mode_name;
        const modeNoulAnswer = typeof modeName === "string"
          ? noulAnswerByMode[modeName]
          : undefined;
        const answer =
          body.questions[question].type === "noul"
            ? { type: "noul", noul: modeNoulAnswer ?? noulAnswer, confidence: confidenceAnswer }
            : { type: "choice", choice, confidence: confidenceAnswer };
        const sendResponse = () => {
          if (response.destroyed) return;
          response.writeHead(status, {
            "Content-Type": "application/json",
            Connection: "close",
          });
          response.end(JSON.stringify({ answers: { [question]: answer } }));
        };
        if (responseDelayMs > 0) setTimeout(sendResponse, responseDelayMs);
        else sendResponse();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected local TCP endpoint");

    // Do not inherit hook controls, credentials, provider overrides, or a live
    // workspace. The same environment is used for baseline/shadow/active;
    // only OMC_JEV changes, including disabling advisory throttling equally.
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
      OMC_JEV_TIMEOUT_MS: "2000",
      OMC_PRE_TOOL_ADVISORY_COOLDOWN_MS: "0",
      TYPESAFE_API_KEY: API_KEY,
      OMC_JEV_ENDPOINT: `http://127.0.0.1:${address.port}/v1/systemone`,
    };
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(cwd, { recursive: true, force: true });
  });

  function taskInput(toolName = "Task") {
    return {
      toolName,
      toolInput: {
        model: "haiku",
        description: "test task",
        prompt: "build something",
      },
      directory: cwd,
      sessionId: "test-sess-model",
      prompt: "",
    };
  }

  function persistentModeInput(sessionId: string) {
    return {
      cwd,
      sessionId,
      directory: cwd,
      last_assistant_message: "The implementation is complete.",
    };
  }

  function createRalphState(
    sessionId: string,
    overrides: Record<string, unknown> = {},
  ) {
    const now = new Date().toISOString();
    return {
      active: true,
      mode: "ralph",
      iteration: 1,
      max_iterations: 5,
      session_id: sessionId,
      project_path: cwd,
      started_at: now,
      last_checked_at: now,
      updated_at: now,
      ...overrides,
    };
  }

  function createAutopilotState(sessionId: string) {
    const now = new Date().toISOString();
    return {
      active: true,
      mode: "autopilot",
      phase: "qa",
      current_phase: "qa",
      session_id: sessionId,
      project_path: cwd,
      started_at: now,
      last_checked_at: now,
      updated_at: now,
      reinforcement_count: 0,
    };
  }

  function writeSessionState(
    sessionId: string,
    fileName: string,
    state: Record<string, unknown>,
  ) {
    const sessionStateDir = join(
      cwd,
      ".omc",
      "non-git",
      "state",
      "sessions",
      sessionId,
    );
    mkdirSync(sessionStateDir, { recursive: true });
    const statePath = join(sessionStateDir, fileName);
    writeFileSync(statePath, JSON.stringify(state, null, 2));
    return statePath;
  }

  function keywordInput() {
    return {
      prompt: "Please perform a code review of this change.",
      cwd,
      session_id: "test-sess-keyword",
    };
  }

  function assertWireContract(
    request: WireRequest,
    question: string,
    extraQuestions: string[] = [],
  ) {
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/v1/systemone");
    expect(request.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(request.headers["content-type"]).toBe("application/json");
    expect(Object.keys(request.body).sort()).toEqual([
      "model",
      "questions",
      "state",
    ]);
    expect(request.body.model).toBe("jev-latest");
    expect(Object.keys(request.body.questions)).toEqual([
      question,
      ...extraQuestions,
    ]);
    expect(request.body.questions[question].type).toBe("choice");
    expect(request.body.questions[question].instructions).toEqual(
      expect.any(String),
    );
  }

  async function waitForShadowLog(point: string) {
    // Shadow children are intentionally detached. Wait for their completed log
    // write before closing the server/removing the temporary workspace.
    const startTime = Date.now();
    const timeout = 5000;
    while (Date.now() - startTime < timeout) {
      try {
        const entries = readFileSync(
          join(cwd, "jev-logs", "shadow.jsonl"),
          "utf8",
        )
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const found = entries.some(e => e.point === point && e.mode === "shadow");
        if (found) {
          expect(entries).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ point, mode: "shadow" }),
            ]),
          );
          return;
        }
      } catch (e) {
        // File might not exist yet
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Timeout waiting for shadow log entry for point ${point}`);
  }

  it.each(["Task", "Agent"])(
    "pre-tool-enforcer.mjs: OMC_JEV=all:active injects Jev model (opus) when requesting haiku via %s",
    async (toolName) => {
      const input = taskInput(toolName);
      const result = await runScript(
        "pre-tool-enforcer.mjs",
        input,
        { ...env, OMC_JEV: "all:active" },
        cwd,
      );
      expect(result.exitCode, result.stderr).toBe(0);
      expect(requests.length).toBeGreaterThanOrEqual(1);
      const request = requests.find(
        (entry) => "model-tier" in entry.body.questions,
      );
      expect(request).toBeDefined();
      assertWireContract(request!, "model-tier", ["effort"]);
      expect(request!.body.questions.effort.type).toBe("score");
      expect(request!.body.state).toEqual({
        tool_name: toolName,
        subagent_type: "",
        task: input.toolInput.prompt,
      });
      expect(
        Object.keys(request!.body.questions["model-tier"].criteria).sort(),
      ).toEqual(["haiku", "opus", "sonnet"]);
      const output = JSON.parse(result.stdout);
      expect(output.continue).toBe(true);
      expect(output.hookSpecificOutput.hookEventName).toBe("PreToolUse");
      expect(output.hookSpecificOutput.updatedInput).toEqual({
        ...input.toolInput,
        model: "opus",
      });
      expect(output.hookSpecificOutput.updatedInput.model).toBe("opus");
    },
    15000,
  );

  it("pre-tool-enforcer.mjs: malformed timeout uses the resolver fallback before adding the active parent buffer", async () => {
    responseDelayMs = 750;
    const input = taskInput();
    const result = await runScript(
      "pre-tool-enforcer.mjs",
      input,
      {
        ...env,
        OMC_JEV: "model-routing:active",
        OMC_JEV_TIMEOUT_MS: "1e3",
      },
      cwd,
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(requests.some((entry) => "model-tier" in entry.body.questions)).toBe(
      true,
    );
    expect(JSON.parse(result.stdout).hookSpecificOutput.updatedInput.model).toBe(
      "opus",
    );
  }, 15000);

  it("pre-tool-enforcer.mjs: point active overrides an earlier shadow wildcard", async () => {
    const input = taskInput();
    const result = await runScript(
      "pre-tool-enforcer.mjs",
      input,
      { ...env, OMC_JEV: "all,model-routing:active" },
      cwd,
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(requests.some((entry) => "model-tier" in entry.body.questions)).toBe(
      true,
    );
    expect(JSON.parse(result.stdout).hookSpecificOutput.updatedInput).toEqual({
      ...input.toolInput,
      model: "opus",
    });
    await waitForShadowLog("slop-warning");
  }, 15000);

  it("pre-tool-enforcer.mjs: OMC_JEV=all:active gracefully degrades when Jev unavailable", async () => {
    status = 503;
    const input = taskInput();
    const baseline = await runScript("pre-tool-enforcer.mjs", input, env, cwd);
    const result = await runScript(
      "pre-tool-enforcer.mjs",
      input,
      { ...env, OMC_JEV: "all:active" },
      cwd,
    );
    expect(baseline.exitCode, baseline.stderr).toBe(0);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(requests.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(result.stdout).continue).toBe(true);
    expect(result.stdout).toBe(baseline.stdout);
  }, 15000);

  it("pre-tool-enforcer.mjs: OMC_JEV=all (shadow) output is identical to Jev unset", async () => {
    const input = taskInput();
    const baseline = await runScript("pre-tool-enforcer.mjs", input, env, cwd);
    expect(requests).toHaveLength(0);
    const shadow = await runScript(
      "pre-tool-enforcer.mjs",
      input,
      { ...env, OMC_JEV: "all" },
      cwd,
    );
    expect(baseline.exitCode, baseline.stderr).toBe(0);
    expect(shadow.exitCode, shadow.stderr).toBe(0);
    expect(shadow.stdout).toBe(baseline.stdout);
    await waitForShadowLog("model-routing");
    await waitForShadowLog("slop-warning");
    expect(requests.length).toBeGreaterThanOrEqual(1);
  }, 15000);

  it("keyword-detector.mjs: active none suppresses the baseline emitted code-review skill", async () => {
    choice = "none";
    const input = keywordInput();
    const baseline = await runScript("keyword-detector.mjs", input, env, cwd);
    expect(baseline.exitCode, baseline.stderr).toBe(0);
    expect(
      JSON.parse(baseline.stdout).hookSpecificOutput.additionalContext,
    ).toContain("code-review");
    expect(requests).toHaveLength(0);
    const active = await runScript(
      "keyword-detector.mjs",
      input,
      { ...env, OMC_JEV: "skill-trigger:active" },
      cwd,
    );
    expect(active.exitCode, active.stderr).toBe(0);
    expect(requests).toHaveLength(1);
    assertWireContract(requests[0], "skill-trigger");
    expect(requests[0].body.state).toEqual({
      prompt: input.prompt.toLowerCase(),
      source: "user-prompt-submit",
    });
    expect(requests[0].body.questions["skill-trigger"].criteria).toHaveProperty(
      "none",
    );
    // No resolved keyword means the real script emits its pass-through output.
    expect(JSON.parse(active.stdout)).toEqual({
      continue: true,
      suppressOutput: true,
    });
    expect(active.stdout).not.toBe(baseline.stdout);
  }, 15000);

  it("keyword-detector.mjs: active code-review choice replaces the baseline tdd and code-review selection", async () => {
    choice = "code-review";
    const input = {
      ...keywordInput(),
      prompt: "Use tdd and perform a code review of this change.",
    };
    const baseline = await runScript("keyword-detector.mjs", input, env, cwd);
    expect(baseline.exitCode, baseline.stderr).toBe(0);
    const baselineContext = JSON.parse(baseline.stdout).hookSpecificOutput
      .additionalContext;
    expect(baselineContext).toContain("tdd");
    expect(baselineContext).toContain("code-review");
    const active = await runScript(
      "keyword-detector.mjs",
      input,
      { ...env, OMC_JEV: "skill-trigger:active" },
      cwd,
    );
    expect(active.exitCode, active.stderr).toBe(0);
    expect(requests).toHaveLength(1);
    assertWireContract(requests[0], "skill-trigger");
    const activeContext = JSON.parse(active.stdout).hookSpecificOutput
      .additionalContext;
    expect(activeContext).toContain("code-review");
    expect(activeContext).not.toContain("tdd");
    expect(active.stdout).not.toBe(baseline.stdout);
  }, 15000);

  it("keyword-detector.mjs: shadow none preserves byte-identical output to Jev unset", async () => {
    choice = "none";
    const input = keywordInput();
    const baseline = await runScript("keyword-detector.mjs", input, env, cwd);
    const shadow = await runScript(
      "keyword-detector.mjs",
      input,
      { ...env, OMC_JEV: "skill-trigger" },
      cwd,
    );
    expect(baseline.exitCode, baseline.stderr).toBe(0);
    expect(shadow.exitCode, shadow.stderr).toBe(0);
    expect(
      JSON.parse(baseline.stdout).hookSpecificOutput.additionalContext,
    ).toContain("code-review");
    expect(shadow.stdout).toBe(baseline.stdout);
    await waitForShadowLog("skill-trigger");
    expect(requests).toHaveLength(1);
    assertWireContract(requests[0], "skill-trigger");
  }, 15000);

  it("keyword-detector.mjs: endpoint failure preserves the baseline emitted skill", async () => {
    status = 503;
    const input = keywordInput();
    const baseline = await runScript("keyword-detector.mjs", input, env, cwd);
    const active = await runScript(
      "keyword-detector.mjs",
      input,
      { ...env, OMC_JEV: "skill-trigger:active" },
      cwd,
    );
    expect(baseline.exitCode, baseline.stderr).toBe(0);
    expect(active.exitCode, active.stderr).toBe(0);
    expect(requests).toHaveLength(1);
    assertWireContract(requests[0], "skill-trigger");
    expect(
      JSON.parse(active.stdout).hookSpecificOutput.additionalContext,
    ).toContain("code-review");
    expect(active.stdout).toBe(baseline.stdout);
  }, 15000);

  it("pre-tool-enforcer.mjs: plan mode with OMC_JEV_PLAN_MODE=shadow keeps the requested model and logs shadow", async () => {
    const input = { ...taskInput("Agent"), permission_mode: "plan" };
    const baseline = await runScript("pre-tool-enforcer.mjs", input, env, cwd);
    const planShadow = await runScript(
      "pre-tool-enforcer.mjs",
      input,
      { ...env, OMC_JEV: "model-routing:active", OMC_JEV_PLAN_MODE: "shadow" },
      cwd,
    );
    expect(baseline.exitCode, baseline.stderr).toBe(0);
    expect(planShadow.exitCode, planShadow.stderr).toBe(0);
    expect(planShadow.stdout).toBe(baseline.stdout);
    await waitForShadowLog("model-routing");
    expect(requests.some((entry) => "model-tier" in entry.body.questions)).toBe(
      true,
    );
  }, 15000);

  it("pre-tool-enforcer.mjs: plan mode without OMC_JEV_PLAN_MODE still lets the active point override the model", async () => {
    const input = { ...taskInput("Agent"), permission_mode: "plan" };
    const result = await runScript(
      "pre-tool-enforcer.mjs",
      input,
      { ...env, OMC_JEV: "model-routing:active" },
      cwd,
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.updatedInput).toEqual({
      ...input.toolInput,
      model: "opus",
    });
  }, 15000);

  it("pre-tool-enforcer.mjs: plan mode with OMC_JEV_PLAN_MODE=off sends no Jev request", async () => {
    const input = { ...taskInput("Agent"), permission_mode: "plan" };
    const baseline = await runScript("pre-tool-enforcer.mjs", input, env, cwd);
    const planOff = await runScript(
      "pre-tool-enforcer.mjs",
      input,
      { ...env, OMC_JEV: "all:active", OMC_JEV_PLAN_MODE: "off" },
      cwd,
    );
    expect(planOff.exitCode, planOff.stderr).toBe(0);
    expect(planOff.stdout).toBe(baseline.stdout);
    // A detached shadow child would post after the hook exits; give it time.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(requests).toHaveLength(0);
  }, 15000);

  it("keyword-detector.mjs: plan mode with OMC_JEV_PLAN_MODE=shadow keeps the baseline skill when active Jev says none", async () => {
    choice = "none";
    const input = { ...keywordInput(), permission_mode: "plan" };
    const baseline = await runScript("keyword-detector.mjs", input, env, cwd);
    const planShadow = await runScript(
      "keyword-detector.mjs",
      input,
      { ...env, OMC_JEV: "skill-trigger:active", OMC_JEV_PLAN_MODE: "shadow" },
      cwd,
    );
    expect(baseline.exitCode, baseline.stderr).toBe(0);
    expect(planShadow.exitCode, planShadow.stderr).toBe(0);
    expect(
      JSON.parse(baseline.stdout).hookSpecificOutput.additionalContext,
    ).toContain("code-review");
    expect(planShadow.stdout).toBe(baseline.stdout);
    await waitForShadowLog("skill-trigger");
    expect(requests).toHaveLength(1);
  }, 15000);

  it("keyword-detector.mjs: task-size:active with small answer filters heavy keywords (issue #4805)", async () => {
    // This test verifies the fix for issue #4805: when task-size returns 'small',
    // heavy keywords (ralph, autopilot, team, ralplan) are filtered out
    const input = {
      prompt: "Please use ralph and autopilot to fix this.",  // Contains 2 heavy keywords
      cwd,
      session_id: "test-sess-keyword",
    };
    
    // Baseline: Run without Jev to see default behavior
    requests = [];
    const baseline = await runScript(
      "keyword-detector.mjs",
      input,
      env,
      cwd,
    );
    expect(baseline.exitCode, baseline.stderr).toBe(0);
    const baselineOutput = JSON.parse(baseline.stdout).hookSpecificOutput.additionalContext;
    // Default should include both 'ralph' and 'autopilot' since they're in the prompt
    expect(baselineOutput).toContain("ralph");
    expect(baselineOutput).toContain("autopilot");
    
    // Run with task-size:active returning 'small'
    // Heavy keywords should be filtered out
    requests = [];
    choice = "small";
    const withSmall = await runScript(
      "keyword-detector.mjs",
      input,
      { ...env, OMC_JEV: "task-size:active" },
      cwd,
    );
    expect(withSmall.exitCode, withSmall.stderr).toBe(0);
    const smallParsed = JSON.parse(withSmall.stdout);
    expect(smallParsed.suppressOutput).toBe(true);
    expect(withSmall.stdout).not.toContain("ralph");
    expect(withSmall.stdout).not.toContain("autopilot");
    
    // Verify task-size request was made
    const taskSizeRequest = requests.find((entry) => "task-size" in entry.body.questions);
    expect(taskSizeRequest).toBeDefined();
    assertWireContract(taskSizeRequest!, "task-size");
  }, 15000);

  it("keyword-detector.mjs: low-confidence small task-size keeps ralph", async () => {
    const input = {
      prompt: "Please use ralph to fix this.",
      cwd,
      session_id: "test-sess-keyword",
    };
    choice = "small";
    confidenceAnswer = 0.5;

    const result = await runScript(
      "keyword-detector.mjs",
      input,
      { ...env, OMC_JEV: "task-size:active" },
      cwd,
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain("ralph");
    expect(requests.some((entry) => "task-size" in entry.body.questions)).toBe(true);
  }, 15000);

  it("keyword-detector.mjs: slash-invoked ralph survives small task-size classification", async () => {
    const input = {
      prompt: "/oh-my-claudecode:ralph fix typo",
      cwd,
      session_id: "test-sess-keyword",
    };
    choice = "small";

    const result = await runScript(
      "keyword-detector.mjs",
      input,
      { ...env, OMC_JEV: "task-size:active" },
      cwd,
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain("ralph");
    expect(requests.some((entry) => "task-size" in entry.body.questions)).toBe(true);
  }, 15000);

  it("keyword-detector.mjs: task-size suppression opt-out keeps ralph", async () => {
    const input = {
      prompt: "Please use ralph and autopilot to fix this.",
      cwd,
      session_id: "test-sess-keyword",
    };
    const configDir = join(cwd, ".claude");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "omc.jsonc"),
      JSON.stringify({
        taskSizeDetection: { suppressHeavyModesForSmallTasks: false },
      }),
    );
    choice = "small";

    const result = await runScript(
      "keyword-detector.mjs",
      input,
      { ...env, OMC_JEV: "task-size:active" },
      cwd,
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain("ralph");
    expect(requests.some((entry) => "task-size" in entry.body.questions)).toBe(true);
  }, 15000);

  it("keyword-detector.mjs: disabled task-size detection never suppresses ralph", async () => {
    const input = {
      prompt: "Please use ralph and autopilot to fix this.",
      cwd,
      session_id: "test-sess-keyword",
    };
    const configDir = join(cwd, ".claude");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "omc.jsonc"),
      JSON.stringify({ taskSizeDetection: { enabled: false } }),
    );
    choice = "small";

    const result = await runScript(
      "keyword-detector.mjs",
      input,
      { ...env, OMC_JEV: "task-size:active" },
      cwd,
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain("ralph");
    expect(requests.some((entry) => "task-size" in entry.body.questions)).toBe(true);
  }, 15000);

  it("keyword-detector.mjs: task-size:active with non-small answer preserves heavy keywords (issue #4805)", async () => {
    // This test verifies that when task-size returns something other than 'small',
    // heavy keywords are NOT filtered (preserving original behavior)
    const input = {
      prompt: "Please use ralph to fix this.",
      cwd,
      session_id: "test-sess-keyword",
    };
    
    // Run with task-size:active returning 'opus' (not 'small')
    requests = [];
    choice = "opus";
    const withOpus = await runScript(
      "keyword-detector.mjs",
      input,
      { ...env, OMC_JEV: "task-size:active" },
      cwd,
    );
    expect(withOpus.exitCode, withOpus.stderr).toBe(0);
    const opusOutput = JSON.parse(withOpus.stdout).hookSpecificOutput.additionalContext;
    // When task-size returns 'opus' (not 'small'), 'ralph' should still be there
    expect(opusOutput).toContain("ralph");
    
    // Verify task-size request was made
    const taskSizeRequest = requests.find((entry) => "task-size" in entry.body.questions);
    expect(taskSizeRequest).toBeDefined();
    assertWireContract(taskSizeRequest!, "task-size");
  }, 15000);


  it("persistent-mode.mjs: active Ralph completion sets both terminal phase fields", async () => {
    const sessionId = "test-sess-ralph-complete";
    const statePath = writeSessionState(
      sessionId,
      "ralph-state.json",
      createRalphState(sessionId),
    );
    requests = [];
    noulAnswer = 0.95;

    const result = await runScript(
      "persistent-mode.mjs",
      persistentModeInput(sessionId),
      { ...env, OMC_JEV: "loop-continuation:active" },
      cwd,
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).decision).toBe("continue");
    const taskCompleteRequest = requests.find(
      (entry) => "task_complete" in entry.body.questions,
    );
    expect(taskCompleteRequest).toBeDefined();
    expect(taskCompleteRequest!.body.state.last_assistant_message).toBe(
      "The implementation is complete.",
    );
    expect(taskCompleteRequest!.body.questions.task_complete.type).toBe("noul");

    const resultingState = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    expect(resultingState.active).toBe(false);
    expect(resultingState.phase).toBe("complete");
    expect(resultingState.current_phase).toBe("complete");
    expect(resultingState.completed_at).toEqual(expect.any(String));
  }, 15000);

  it("persistent-mode.mjs: incomplete active Ralph remains blocking and active", async () => {
    const sessionId = "test-sess-ralph-incomplete";
    const statePath = writeSessionState(
      sessionId,
      "ralph-state.json",
      createRalphState(sessionId),
    );
    noulAnswer = 0.2;

    const result = await runScript(
      "persistent-mode.mjs",
      persistentModeInput(sessionId),
      { ...env, OMC_JEV: "loop-continuation:active" },
      cwd,
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).decision).toBe("block");
    const resultingState = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    expect(resultingState.active).toBe(true);
    expect(resultingState.phase).not.toBe("complete");
    expect(resultingState.current_phase).not.toBe("complete");
  }, 15000);

  it("persistent-mode.mjs: stale Ralph completion guard blocks without overwriting concurrent state", async () => {
    const sessionId = "test-sess-ralph-stale";
    const statePath = writeSessionState(
      sessionId,
      "ralph-state.json",
      createRalphState(sessionId),
    );
    let concurrentIteration = 0;
    onTaskCompleteRequest = () => {
      const currentState = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
      concurrentIteration = Number(currentState.iteration) + 1;
      writeFileSync(
        statePath,
        JSON.stringify({
          ...currentState,
          iteration: concurrentIteration,
          updated_at: new Date(Date.now() + 1000).toISOString(),
        }, null, 2),
      );
    };
    noulAnswer = 0.95;

    const result = await runScript(
      "persistent-mode.mjs",
      persistentModeInput(sessionId),
      { ...env, OMC_JEV: "loop-continuation:active" },
      cwd,
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).decision).toBe("block");
    const resultingState = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    expect(resultingState.iteration).toBe(concurrentIteration);
    expect(resultingState.active).toBe(true);
    expect(resultingState.phase).not.toBe("complete");
    expect(resultingState.current_phase).not.toBe("complete");
  }, 15000);

  it("persistent-mode.mjs: Ralph extends at max iterations and still honors Jev completion", async () => {
    const sessionId = "test-sess-ralph-extend";
    const statePath = writeSessionState(
      sessionId,
      "ralph-state.json",
      createRalphState(sessionId, { iteration: 3, max_iterations: 3 }),
    );
    noulAnswer = 0.95;

    const completed = await runScript(
      "persistent-mode.mjs",
      persistentModeInput(sessionId),
      { ...env, OMC_JEV: "loop-continuation:active" },
      cwd,
    );

    expect(completed.exitCode, completed.stderr).toBe(0);
    expect(JSON.parse(completed.stdout).decision).toBe("continue");
    const completedState = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    expect(completedState.active).toBe(false);
    expect(completedState.max_iterations).toBe(13);
    expect(completedState.phase).toBe("complete");
    expect(completedState.current_phase).toBe("complete");

    writeSessionState(
      sessionId,
      "ralph-state.json",
      createRalphState(sessionId, { iteration: 3, max_iterations: 3 }),
    );
    requests = [];
    const extended = await runScript(
      "persistent-mode.mjs",
      persistentModeInput(sessionId),
      env,
      cwd,
    );

    expect(extended.exitCode, extended.stderr).toBe(0);
    expect(JSON.parse(extended.stdout)).toMatchObject({ decision: "block" });
    expect(JSON.parse(extended.stdout).reason).toContain("[RALPH LOOP - EXTENDED]");
    expect(requests).toHaveLength(0);
    const extendedState = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    expect(extendedState.active).toBe(true);
    expect(extendedState.max_iterations).toBe(13);
  }, 15000);

  it("persistent-mode.mjs: completing child Ralph leaves active autopilot enforcement in control", async () => {
    const sessionId = "test-sess-ralph-parent";
    const ralphPath = writeSessionState(
      sessionId,
      "ralph-state.json",
      createRalphState(sessionId),
    );
    const autopilotPath = writeSessionState(
      sessionId,
      "autopilot-state.json",
      createAutopilotState(sessionId),
    );
    noulAnswerByMode = { ralph: 0.95, autopilot: 0.2 };

    const result = await runScript(
      "persistent-mode.mjs",
      persistentModeInput(sessionId),
      { ...env, OMC_JEV: "loop-continuation:active" },
      cwd,
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.decision).toBe("block");
    expect(output.reason).toContain("[AUTOPILOT - Phase: qa]");
    expect(requests.map((entry) => entry.body.state.mode_name)).toEqual([
      "ralph",
      "autopilot",
    ]);
    const ralphState = JSON.parse(readFileSync(ralphPath, "utf8")) as Record<string, unknown>;
    const autopilotState = JSON.parse(readFileSync(autopilotPath, "utf8")) as Record<string, unknown>;
    expect(ralphState.active).toBe(false);
    expect(ralphState.current_phase).toBe("complete");
    expect(autopilotState.active).toBe(true);
    expect(autopilotState.reinforcement_count).toBe(1);
  }, 15000);

  it("persistent-mode.mjs: autopilot completion sets both phase and current_phase", async () => {
    // Verify that the production completion handler sets BOTH phase fields
    // when Jev signals task completion (noul >= 0.5), not just current_phase.
    // This prevents the completed-run resumption bug in canResumeAutopilot().
    // Exercise the production code by running persistent-mode.mjs with a state that
    // triggers the completion handler.
    const sessionId = "test-sess-handler";
    const autopilotStatePath = writeSessionState(
      sessionId,
      "autopilot-state.json",
      createAutopilotState(sessionId),
    );
    const input = persistentModeInput(sessionId);
    
    requests = [];
    noulAnswer = 0.95;
    const result = await runScript(
      "persistent-mode.mjs",
      input,
      { ...env, OMC_JEV: "loop-continuation:active" },
      cwd,
    );
    
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).decision).toBe("continue");
    
    // Verify that Jev was called with the task_complete question
    const taskCompleteRequest = requests.find(
      (entry) => "task_complete" in entry.body.questions
    );
    expect(taskCompleteRequest).toBeDefined();
    // Verify the wire contract (adapted for noul questions)
    const req = taskCompleteRequest!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/v1/systemone");
    expect(req.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.body.questions["task_complete"].type).toBe("noul");
    expect(req.body.questions["task_complete"].instructions).toEqual(
      expect.any(String),
    );
    expect(req.body.state.last_assistant_message).toBe(
      "The implementation is complete.",
    );
    
    // Read the resulting state file and verify BOTH phase fields are set to 'complete'
    const resultingState = JSON.parse(readFileSync(autopilotStatePath, "utf8")) as Record<string, unknown>;
    expect(resultingState.active).toBe(false);
    expect(resultingState.phase).toBe("complete");
    expect(resultingState.current_phase).toBe("complete");
    expect(resultingState.completed_at).toBeDefined();
    expect(typeof resultingState.completed_at).toBe("string");
  }, 15000);
});

