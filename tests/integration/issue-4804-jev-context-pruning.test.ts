/**
 * Real post-tool-verifier.mjs active Jev coverage for issue #4804.
 *
 * The mock returns the API's real score shape: `score`, `confidence`,
 * `legend`, `probabilities`, and no `choice`.
 */
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const API_KEY = "test-key-123";

/** A staleness answer as the API sends it: 0 = fresh ... 3 = stale, no `choice`. */
function scoreAnswer(score: unknown, extra: Record<string, unknown> = {}) {
  return {
    type: "score",
    score,
    confidence: 0.7,
    legend: { "0": "Fresh — keep", "1": "Recent", "2": "Aging", "3": "Stale — prune candidate" },
    probabilities: { "0": 0.2, "1": 0.4, "2": 0.3, "3": 0.1 },
    ...extra,
  };
}

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
  let answer: Record<string, unknown>;
  let responseDelayMs: number;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "jev-context-pruning-"));
    requests = [];
    status = 200;
    answer = scoreAnswer(0);
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
        console.log("[jev context-pruning request]", entry);

        const question = Object.keys(body.questions)[0];

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

  /** Run the hook in active mode and return its additionalContext ("" when none). */
  async function activeContext(contextPercent: number, sessionSuffix = "") {
    const result = await runScript(
      "post-tool-verifier.mjs",
      postToolInput("read", contextPercent, sessionSuffix),
      { ...env, OMC_JEV: "context-pruning:active" },
      cwd,
    );
    expect(result.exitCode, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    return (output.hookSpecificOutput?.additionalContext ?? "") as string;
  }

  it("post-tool-verifier.mjs: OMC_JEV=context-pruning:active sends the staleness score question", async () => {
    answer = scoreAnswer(1.53);
    await activeContext(80);
    const request = requests.find(
      (entry) => "staleness" in entry.body.questions,
    );
    expect(request).toBeDefined();
    assertWireContract(request!, "staleness", "score");
    expect(request!.body.state).toHaveProperty("context_percent", 80);
    expect(request!.body.state).toHaveProperty("action", "warn");
  });

  // Below the critical threshold (80%, heuristic: warn) the rounded score decides.
  it.each([
    { score: 0, expected: "no message" },
    { score: 0.49, expected: "no message" },
    { score: 0.5, expected: "no message" },
    { score: 1.49, expected: "no message" },
    { score: 1.5, expected: "WARNING" },
    { score: 1.53, expected: "WARNING" },
    { score: 2.49, expected: "WARNING" },
    { score: 2.5, expected: "CRITICAL" },
    { score: 3, expected: "CRITICAL" },
  ])("post-tool-verifier.mjs: active score $score at 80 percent gives $expected", async ({ score, expected }) => {
    answer = scoreAnswer(score);
    const context = await activeContext(80);
    if (expected === "no message") {
      expect(context).toBe("");
    } else {
      expect(context).toContain(expected);
      if (expected === "WARNING") expect(context).not.toContain("CRITICAL");
    }
  });

  // At or above the critical threshold Jev never lowers the level. This
  // replaces the earlier expectation that "aging" at 95% drops CRITICAL.
  it.each([
    { percent: 92, score: 1, label: "recent" },
    { percent: 92, score: 2, label: "aging" },
    { percent: 95, score: 0, label: "fresh" },
    { percent: 95, score: 1, label: "recent" },
    { percent: 95, score: 2, label: "aging" },
  ])("post-tool-verifier.mjs: active at $percent percent keeps CRITICAL when Jev scores $score ($label)", async ({ percent, score }) => {
    answer = scoreAnswer(score);
    expect(await activeContext(percent)).toContain("[OMC CRITICAL]");
  });

  it.each([
    ["score -1", scoreAnswer(-1)],
    ["score 3.4", scoreAnswer(3.4)],
    ["score 99", scoreAnswer(99)],
    ["score NaN as text", scoreAnswer("NaN")],
    ["a choice-type answer carrying a score", { type: "choice", score: 0, confidence: 0.9 }],
    ["a choice-type answer carrying a label choice", { type: "choice", choice: "fresh", confidence: 0.9 }],
    ["a non-string choice", { type: "score", choice: 42, confidence: 0.9 }],
  ])("post-tool-verifier.mjs: active ignores %s and keeps the heuristic", async (_label, malformed) => {
    answer = malformed;
    // Heuristic at 80% is warn: WARNING, not suppressed and not raised.
    const context = await activeContext(80);
    expect(context).toContain("WARNING");
    expect(context).not.toContain("CRITICAL");
  });

  it("post-tool-verifier.mjs: a string choice label, when present, still maps", async () => {
    answer = { type: "score", choice: "STALE", confidence: 0.9 };
    expect(await activeContext(80)).toContain("CRITICAL");
  });

  it("post-tool-verifier.mjs: an unknown choice string does not hide a valid score", async () => {
    answer = scoreAnswer(3, { choice: "x" });
    expect(await activeContext(80)).toContain("CRITICAL");
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
    answer = scoreAnswer(3);
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

    // Score 3 (stale) at 75% raises the heuristic warn to CRITICAL.
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput.additionalContext).toContain("[OMC CRITICAL]");
  });
});
