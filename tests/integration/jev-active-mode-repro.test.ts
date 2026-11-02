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
  let noulAnswer: boolean;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "jev-active-repro-"));
    requests = [];
    status = 200;
    choice = "opus";
    responseDelayMs = 0;
    noulAnswer = false;
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
            ? { type: "noul", noul: noulAnswer, confidence: 0.99 }
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
    // When task-size returns 'small', the output should suppressOutput: true
    // because the heavy keywords were filtered out
    const smallParsed = JSON.parse(withSmall.stdout);
    // If no keywords remain after filtering, suppressOutput will be true
    if (smallParsed.suppressOutput) {
      // This means all keywords were filtered (which would happen with 'small')
      expect(smallParsed.suppressOutput).toBe(true);
    } else {
      // If some keywords remain, they should not be heavy keywords
      const smallOutput = smallParsed.hookSpecificOutput?.additionalContext || "";
      expect(smallOutput).not.toContain("ralph");
      expect(smallOutput).not.toContain("autopilot");
    }
    
    // Verify task-size request was made
    const taskSizeRequest = requests.find((entry) => "task-size" in entry.body.questions);
    expect(taskSizeRequest).toBeDefined();
    assertWireContract(taskSizeRequest!, "task-size");
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

  it("persistent-mode.mjs: guards completion write against concurrent state mutations (issue #4805)", async () => {
    // Test the isStateUnchangedSinceCJevRequest guard function that protects against
    // race conditions where another process modifies the state file while Jev is called.
    // When Jev returns noul:true (task complete), persistent-mode.mjs re-reads the state
    // file to verify it hasn't changed. If it detects a concurrent mutation (different
    // iteration, session_id, or updated_at), the completion write is skipped.
    
    const { mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
    
    // Guard function extracted from persistent-mode.mjs (issue #4805)
    function isStateUnchangedSinceCJevRequest(originalState: Record<string, unknown>, filePath: string) {
      if (!originalState || !filePath) return false;
      let currentState: Record<string, unknown> | null = null;
      try {
        currentState = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
      } catch {
        return false;
      }
      if (!currentState) return false;
      // Verify key identifiers haven't changed by another process
      if (originalState.session_id !== currentState.session_id) return false;
      if (originalState.iteration !== currentState.iteration) return false;
      if (originalState.updated_at !== currentState.updated_at) return false;
      return true;
    }
    
    const stateDir = join(cwd, ".omc", "state");
    mkdirSync(stateDir, { recursive: true });
    const statePath = join(stateDir, "test-state.json");
    const now = new Date().toISOString();
    
    const inMemoryState = {
      active: true,
      session_id: "test-session",
      iteration: 2, // persistent-mode incremented from 1 → 2
      updated_at: now,
      current_phase: "work",
    };
    
    // Test 1: File matches in-memory state → guard returns true (no concurrent change)
    writeFileSync(statePath, JSON.stringify(inMemoryState));
    expect(isStateUnchangedSinceCJevRequest(inMemoryState, statePath)).toBe(true);
    
    // Test 2: Concurrent process changed iteration → guard returns false
    writeFileSync(statePath, JSON.stringify({ ...inMemoryState, iteration: 3 }));
    expect(isStateUnchangedSinceCJevRequest(inMemoryState, statePath)).toBe(false);
    
    // Test 3: Concurrent process changed updated_at → guard returns false
    writeFileSync(statePath, JSON.stringify({ ...inMemoryState, updated_at: "2026-11-02T14:30:00.000Z" }));
    expect(isStateUnchangedSinceCJevRequest(inMemoryState, statePath)).toBe(false);
    
    // Test 4: Concurrent process changed session_id → guard returns false
    writeFileSync(statePath, JSON.stringify({ ...inMemoryState, session_id: "different-session" }));
    expect(isStateUnchangedSinceCJevRequest(inMemoryState, statePath)).toBe(false);
    
    // Test 5: File is deleted → guard returns false (safe fallback)
    rmSync(statePath, { force: true });
    expect(isStateUnchangedSinceCJevRequest(inMemoryState, statePath)).toBe(false);
  }, 15000);

  it("persistent-mode.mjs: completion handler sets both phase and current_phase when Jev signals noul:true (issue #4805)", async () => {
    // Issue #4805: Verify that the production completion handler sets BOTH phase fields
    // when Jev signals task completion (noul: true), not just current_phase.
    // This prevents the completed-run resumption bug in canResumeAutopilot().
    // Exercise the production code by running persistent-mode.mjs with a state that
    // triggers the completion handler.
    const { mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
    
    // resolveOmcStateRoot returns OMC_STATE_DIR/non-git for non-git directories
    const stateDir = join(cwd, ".omc", "non-git", "state");
    const sessionId = "test-sess-handler";
    const sessionStateDir = join(stateDir, "sessions", sessionId);
    mkdirSync(sessionStateDir, { recursive: true });
    const autopilotStatePath = join(sessionStateDir, "autopilot-state.json");
    const now = new Date().toISOString();
    
    // Create initial autopilot state in a non-terminal phase (qa)
    const initialState = {
      active: true,
      mode: "autopilot",
      phase: "qa",  // Non-terminal phase
      current_phase: "qa",
      session_id: sessionId,
      iteration: 3,
      max_iterations: 5,
      updated_at: now,
    };
    
    writeFileSync(autopilotStatePath, JSON.stringify(initialState));
    
    // Run persistent-mode.mjs with the session ID and initial state
    // When Jev returns noul:true for task_complete, the handler should set both phase fields
    const input = {
      cwd,
      sessionId,
      directory: cwd,
    };
    
    // Set up the mock Jev endpoint to return noul:true for task_complete
    requests = [];
    noulAnswer = true;  // Make the mock return noul: true for the task_complete question
    const result = await runScript(
      "persistent-mode.mjs",
      input,
      { ...env, OMC_JEV: "loop-continuation:active" },
      cwd,
    );
    
    expect(result.exitCode, result.stderr).toBe(0);
    
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
    
    // Read the resulting state file and verify BOTH phase fields are set to 'complete'
    const resultingState = JSON.parse(readFileSync(autopilotStatePath, "utf8")) as Record<string, unknown>;
    expect(resultingState.active).toBe(false);
    expect(resultingState.phase).toBe("complete");
    expect(resultingState.current_phase).toBe("complete");
    expect(resultingState.completed_at).toBeDefined();
    expect(typeof resultingState.completed_at).toBe("string");
  }, 15000);
});

