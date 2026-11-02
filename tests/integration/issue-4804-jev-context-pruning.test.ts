/** Real post-tool-verifier.mjs active Jev coverage for issue #4804. */
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
    questions: Record<string, unknown>;
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
        console.log("[jev context-pruning subprocess]", {
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

describe("jev active-mode context-pruning coverage (issue #4804)", () => {
  let cwd: string;
  let env: NodeJS.ProcessEnv;
  let server: Server;
  let requests: WireRequest[];
  let status: number;
  let stalenesAnswer: string;
  let responseDelayMs: number;
  let malformedChoice: unknown = null;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "jev-context-pruning-"));
    requests = [];
    status = 200;
    stalenesAnswer = "fresh";
    responseDelayMs = 0;
    malformedChoice = null;
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
        console.log("[jev context-pruning request]", entry);

        const question = Object.keys(body.questions)[0];
        const questionDef = body.questions[question] as Record<string, unknown>;
        const isScoreQuestion = questionDef.type === "score";

        // Build the appropriate answer based on question type
        let answer;
        const choiceValue = malformedChoice !== null ? malformedChoice : stalenesAnswer;
        if (isScoreQuestion) {
          // For score questions, return the selected staleness level
          answer = { type: "score", choice: choiceValue, confidence: 0.95 };
        } else {
          answer = { type: "choice", choice: choiceValue, confidence: 0.95 };
        }

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

  function postToolInput(toolName = "read", contextPercent = 95, sessionSuffix = "") {
    const toolResponse =
      "x".repeat(Math.ceil(contextPercent * 100)) + " output continues";
    return {
      tool_name: toolName,
      toolOutput: toolResponse,
      directory: cwd,
      session_id: "test-sess-context-pruning" + sessionSuffix,
      permission_mode: "execution",
      context_window: {
        used_percentage: contextPercent,
      },
    };
  }

  function assertWireContract(
    request: WireRequest,
    question: string,
    expectedQuestionType: string,
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
    expect(Object.keys(request.body.questions)).toEqual([question]);
    const questionDef = request.body.questions[question] as Record<
      string,
      unknown
    >;
    expect(questionDef.type).toBe(expectedQuestionType);
    expect(questionDef.instructions).toEqual(expect.any(String));
  }

  it("post-tool-verifier.mjs: inactive (Jev off) - baseline behavior without active Jev", async () => {
    const input = postToolInput("read", 85);
    const result = await runScript(
      "post-tool-verifier.mjs",
      input,
      env, // No OMC_JEV set
      cwd,
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(requests).toHaveLength(0);
    // At 85% context, should emit a warning message
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput).toBeDefined();
    expect(output.hookSpecificOutput.additionalContext).toContain("WARNING");
  });

  it("post-tool-verifier.mjs: OMC_JEV=context-pruning:active with fresh answer (95%) should NOT compact", async () => {
    stalenesAnswer = "fresh";
    const input = postToolInput("read", 95);
    const result = await runScript(
      "post-tool-verifier.mjs",
      input,
      { ...env, OMC_JEV: "context-pruning:active" },
      cwd,
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(requests.length).toBeGreaterThanOrEqual(1);

    const request = requests.find(
      (entry) => "staleness" in entry.body.questions,
    );
    expect(request).toBeDefined();
    assertWireContract(request!, "staleness", "score");

    // Verify the request state includes context percentage and tool info
    expect(request!.body.state).toHaveProperty("context_percent", 95);
    expect(request!.body.state).toHaveProperty("action");

    // Fresh answer at 95% should suppress the message
    // because Jev decides the answer is 'fresh' (keep context)
    const output = JSON.parse(result.stdout);
    // With 'fresh' answer, no compaction message should be generated
    expect(output.hookSpecificOutput).toBeUndefined();
  });

  it("post-tool-verifier.mjs: OMC_JEV=context-pruning:active with aging answer (95%) should emit warning", async () => {
    stalenesAnswer = "aging";
    const input = postToolInput("read", 95);
    const result = await runScript(
      "post-tool-verifier.mjs",
      input,
      { ...env, OMC_JEV: "context-pruning:active" },
      cwd,
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(requests.length).toBeGreaterThanOrEqual(1);

    const request = requests.find(
      (entry) => "staleness" in entry.body.questions,
    );
    expect(request).toBeDefined();
    assertWireContract(request!, "staleness", "score");

    // Verify the request includes the context percentage
    expect(request!.body.state).toHaveProperty("context_percent", 95);

    // Aging answer at 95% should trigger warning action
    // Maps to 'warn' which produces a warning message (not critical)
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput.additionalContext).toBeDefined();
    // With 'aging' answer, warning should be suggested (not critical)
    expect(output.hookSpecificOutput.additionalContext).toContain("WARNING");
    expect(output.hookSpecificOutput.additionalContext).not.toContain("CRITICAL");
  });

  it("post-tool-verifier.mjs: OMC_JEV=context-pruning:active with stale answer (80%) should trigger compaction", async () => {
    stalenesAnswer = "stale";
    const input = postToolInput("read", 80);
    const result = await runScript(
      "post-tool-verifier.mjs",
      input,
      { ...env, OMC_JEV: "context-pruning:active" },
      cwd,
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(requests.length).toBeGreaterThanOrEqual(1);

    const request = requests.find(
      (entry) => "staleness" in entry.body.questions,
    );
    expect(request).toBeDefined();
    assertWireContract(request!, "staleness", "score");

    // Verify the request includes the context percentage
    expect(request!.body.state).toHaveProperty("context_percent", 80);

    // Stale answer at 80% should trigger compaction action
    // Heuristic would give 'warn', but Jev says 'stale' which becomes 'compact'
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput.additionalContext).toBeDefined();
    // With 'stale' answer, compaction should be suggested
    expect(output.hookSpecificOutput.additionalContext).toContain("CRITICAL");
  });

  it("post-tool-verifier.mjs: OMC_JEV=context-pruning:active with malformed choice (non-string) should emit CRITICAL", async () => {
    malformedChoice = 42; // Non-string choice
    const input = postToolInput("read", 95);
    const result = await runScript(
      "post-tool-verifier.mjs",
      input,
      { ...env, OMC_JEV: "context-pruning:active" },
      cwd,
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(requests.length).toBeGreaterThanOrEqual(1);

    const request = requests.find(
      (entry) => "staleness" in entry.body.questions,
    );
    expect(request).toBeDefined();
    assertWireContract(request!, "staleness", "score");

    // Verify the request includes the context percentage
    expect(request!.body.state).toHaveProperty("context_percent", 95);

    // Malformed choice (non-string) should be treated as invalid,
    // falling back to heuristic action. At 95%, heuristic is 'compact' (CRITICAL).
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput.additionalContext).toBeDefined();
    expect(output.hookSpecificOutput.additionalContext).toContain("CRITICAL");
  });

  it("post-tool-verifier.mjs: OMC_JEV=context-pruning:active gracefully degrades when Jev unavailable", async () => {
    status = 503;
    const input = postToolInput("read", 85);

    const result = await runScript(
      "post-tool-verifier.mjs",
      input,
      { ...env, OMC_JEV: "context-pruning:active" },
      cwd,
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(requests.length).toBeGreaterThanOrEqual(1);

    // Should fall back to heuristic behavior when Jev fails (503 error)
    // With a 503 error, Jev should degrade and the hook should continue without crashing
    const resultJson = JSON.parse(result.stdout);
    expect(resultJson.continue).toBe(true);
    // Should still have attempted Jev (request was made, even though it failed)
  });

  it("post-tool-verifier.mjs: OMC_JEV=context-pruning (shadow mode) sends request but preserves output", async () => {
    const baselineInput = postToolInput("read", 80, "-baseline");
    const baseline = await runScript(
      "post-tool-verifier.mjs",
      baselineInput,
      env, // No OMC_JEV set
      cwd,
    );
    expect(baseline.exitCode, baseline.stderr).toBe(0);
    expect(requests).toHaveLength(0);

    const shadowInput = postToolInput("read", 80, "-shadow");
    const shadow = await runScript(
      "post-tool-verifier.mjs",
      shadowInput,
      { ...env, OMC_JEV: "context-pruning" },
      cwd,
    );

    expect(shadow.exitCode, shadow.stderr).toBe(0);
    // Shadow mode doesn't change the output (no behavior change)
    const shadowJson = JSON.parse(shadow.stdout);
    const baselineJson = JSON.parse(baseline.stdout);
    expect(shadowJson).toEqual(baselineJson);
    // Shadow mode should still attempt the request (in the background, may not complete immediately)
    // Give the detached child a moment to post its request
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(requests.length).toBeGreaterThanOrEqual(1);
  });

  it("post-tool-verifier.mjs: OMC_JEV=all:active includes context-pruning point", async () => {
    stalenesAnswer = "stale";
    const input = postToolInput("read", 75);
    const result = await runScript(
      "post-tool-verifier.mjs",
      input,
      { ...env, OMC_JEV: "all:active" },
      cwd,
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(requests.length).toBeGreaterThanOrEqual(1);

    const request = requests.find(
      (entry) => "staleness" in entry.body.questions,
    );
    expect(request).toBeDefined();
    assertWireContract(request!, "staleness", "score");

    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput).toBeDefined();
    expect(output.hookSpecificOutput.additionalContext).toBeDefined();
  });
});
