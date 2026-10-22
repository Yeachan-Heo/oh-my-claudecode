/** Real script subprocess regressions for issue #4208. */
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "jev-active-repro-"));
    requests = [];
    status = 200;
    choice = "opus";
    responseDelayMs = 0;
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
        const answer =
          body.questions[question].type === "noul"
            ? { type: "noul", noul: false, confidence: 0.99 }
            : { type: "choice", choice, confidence: 0.99 };
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

  function keywordInput() {
    return {
      prompt: "Please perform a code review of this change.",
      cwd,
      session_id: "test-sess-keyword",
    };
  }

  function assertWireContract(request: WireRequest, question: string) {
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
    expect(Object.keys(request.body.questions)).toEqual([question]);
    expect(request.body.questions[question].type).toBe("choice");
    expect(request.body.questions[question].instructions).toEqual(
      expect.any(String),
    );
  }

  async function waitForShadowLog(point: string) {
    // Shadow children are intentionally detached. Wait for their completed log
    // write before closing the server/removing the temporary workspace.
    await vi.waitFor(
      () => {
        const entries = readFileSync(
          join(cwd, "jev-logs", "shadow.jsonl"),
          "utf8",
        )
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ point, mode: "shadow" }),
          ]),
        );
      },
      { timeout: 5000, interval: 25 },
    );
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
      assertWireContract(request!, "model-tier");
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
});
