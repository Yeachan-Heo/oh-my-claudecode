/**
 * model-routing effort: real pre-tool-enforcer.mjs subprocess against a mock
 * Jev endpoint that returns the API's real answer shapes. A score answer has
 * `score`, `legend`, and `probabilities` but no `choice`; the server may put
 * the `effort` answer before `model-tier`, so answers must be read by name.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serializeQuestions } from "../../src/hooks/jev/client.js";
import { getJudgmentPoint } from "../../src/hooks/jev/points.js";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const API_KEY = "test-key-123";

type Answers = Record<string, Record<string, unknown>>;
type WireBody = {
  state: Record<string, unknown>;
  questions: Record<string, { type: string; criteria: unknown }>;
};

function choiceAnswer(choice: string, confidence = 0.9) {
  return {
    type: "choice",
    choice,
    confidence,
    probabilities: { haiku: 0.05, sonnet: 0.05, opus: 0.05, [choice]: 0.9 },
  };
}

function scoreAnswer(score: number, confidence = 0.7) {
  return {
    type: "score",
    score,
    confidence,
    legend: {
      "0": "Low: mechanical work: read, look up, list, copy or transcribe, count; the result follows directly from the data",
      "1": "Medium: a typical change or analysis with clear steps, in one place or following a given procedure or brief",
      "2": "High: multi-file work that needs its own decisions, a diagnosis weighing a few hypotheses, or writing a document",
      "3": "Extra high: in-depth analysis, architecture, a high-stakes review, or a hard bug",
      "4": "Maximum: exceptionally hard, hours of reasoning at the limit of difficulty; rare",
    },
    probabilities: { "0": 0.1, "1": 0.4, "2": 0.4, "3": 0.05, "4": 0.05 },
  };
}

// Keep the test's event loop free: the hook's synchronous Jev child must be
// able to POST to the HTTP server running in this process.
function runEnforcer(input: Record<string, unknown>, env: NodeJS.ProcessEnv, cwd: string) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
    const child = spawn(process.execPath, [join(PROJECT_ROOT, "scripts", "pre-tool-enforcer.mjs")], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
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
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
    child.stdin.on("error", reject);
    child.stdin.end(JSON.stringify(input));
  });
}

// Polling utility to wait for a condition to be true (replacement for vi.waitFor which is not available in vitest 4.1.11)
async function waitFor(
  condition: () => void,
  options: { timeout?: number; interval?: number } = {},
): Promise<void> {
  const { timeout = 5000, interval = 50 } = options;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      condition();
      return; // Condition passed
    } catch (error) {
      // Condition failed, retry after interval
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  // Last attempt before timeout
  condition();
}

describe("pre-tool-enforcer.mjs: Jev model-routing chooses subagent effort", () => {
  let cwd: string;
  let env: NodeJS.ProcessEnv;
  let server: Server;
  let requests: WireBody[];
  let status: number;
  let answersFor: (body: WireBody) => Answers;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "jev-effort-"));
    requests = [];
    status = 200;
    // Default: effort first, model-tier second (reverse of the request order).
    answersFor = () => ({ effort: scoreAnswer(1.2), "model-tier": choiceAnswer("sonnet") });
    server = createServer((request, response) => {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        raw += chunk;
      });
      request.on("end", () => {
        const body = JSON.parse(raw) as WireBody;
        requests.push(body);
        response.writeHead(status, { "Content-Type": "application/json", Connection: "close" });
        response.end(JSON.stringify({ answers: answersFor(body), usage: { input_tokens: 10, output_tokens: 2 } }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected local TCP endpoint");

    // Only model-routing is opted in, so no detached shadow children outlive a test.
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
      OMC_JEV: "model-routing:active",
    };
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function agentInput(extra: Record<string, unknown> = {}) {
    return {
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: {
        description: "Trace the flaky auth test",
        prompt: "Find why src/auth/session.test.ts fails intermittently and fix it.",
        subagent_type: "general-purpose",
        model: "haiku",
        ...extra,
      },
      cwd,
      session_id: "test-sess-effort",
    };
  }

  /** The tool input Claude Code would run: updatedInput when present, else the original. */
  async function routedInput(input: ReturnType<typeof agentInput>, extraEnv: NodeJS.ProcessEnv = {}) {
    const result = await runEnforcer(input, { ...env, ...extraEnv }, cwd);
    expect(result.exitCode, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.continue).toBe(true);
    return (output.hookSpecificOutput?.updatedInput ?? input.tool_input) as Record<string, unknown>;
  }

  it("asks model-tier and an effort score in one request", async () => {
    await routedInput(agentInput());
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0].questions)).toEqual(["model-tier", "effort"]);
    expect(requests[0].questions.effort.type).toBe("score");
    // Score criteria go out as an ordered list, low to high, one per effort level.
    const criteria = requests[0].questions.effort.criteria as string[];
    expect(criteria).toHaveLength(5);
    expect(criteria.map((text) => text.split(":")[0])).toEqual(["Low", "Medium", "High", "Extra high", "Maximum"]);
  }, 15000);

  it("asks the questions of the TypeScript point registry", async () => {
    await routedInput(agentInput());
    const [questionSet] = getJudgmentPoint("model-routing").questions;
    const questions = typeof questionSet === "function" ? questionSet() : questionSet;
    expect(requests[0].questions).toEqual(JSON.parse(JSON.stringify(serializeQuestions(questions))));
  }, 15000);

  it("asks for the cheapest model that does the work well, with a description per model", async () => {
    await routedInput(agentInput());
    const tier = requests[0].questions["model-tier"] as unknown as {
      type: string;
      instructions: string;
      criteria: Record<string, string>;
    };
    expect(tier.type).toBe("choice");
    // The answer keys are the model names the hook maps onto the call; the descriptions say what each one is for.
    expect(Object.keys(tier.criteria)).toEqual(["haiku", "sonnet", "opus"]);
    expect(tier.criteria.haiku).toMatch(/^Haiku: mechanical work/);
    expect(tier.criteria.sonnet).toMatch(/^Sonnet: typical developer and analyst work/);
    expect(tier.criteria.opus).toMatch(/^Opus: work where a mistake is costly or hard to notice/);
    expect(tier.instructions).toContain("cheapest model that will do the work well");
    expect(tier.instructions).toContain("hardest important part of the work");
    // Effort is the other question's job, and neither the brief's length nor its formal conditions raise the model.
    expect(tier.instructions).toContain("Reasoning effort is chosen by a separate question");
    expect(tier.instructions).toContain("do not raise the choice");
  }, 15000);

  it("sends the model-tier question whole, whatever OMC_JEV_EXCERPT_CHARS is", async () => {
    await routedInput(agentInput());
    const baseline = requests[0].questions["model-tier"] as unknown as { instructions: string; criteria: Record<string, string> };
    expect(baseline.instructions.length).toBeGreaterThan(200);
    expect(baseline.criteria.sonnet.length).toBeGreaterThan(200);
    await routedInput(agentInput(), { OMC_JEV_EXCERPT_CHARS: "50" });
    expect(requests[1].questions["model-tier"]).toEqual(baseline);
    // model-routing has its own excerpt limit, which bounds the state and never the question definitions.
    await routedInput(agentInput(), { OMC_JEV_EXCERPT_CHARS_MODEL_ROUTING: "50" });
    expect(requests[2].questions["model-tier"]).toEqual(baseline);
  }, 15000);

  it("sends the effort question whole, whatever OMC_JEV_EXCERPT_CHARS is", async () => {
    await routedInput(agentInput());
    const baseline = requests[0].questions.effort as unknown as { instructions: string; criteria: string[] };
    expect(baseline.instructions.length).toBeGreaterThan(200);
    expect(baseline.instructions).toContain("do not raise the level");
    await routedInput(agentInput(), { OMC_JEV_EXCERPT_CHARS: "50" });
    expect(requests[1].questions.effort).toEqual(baseline);
  }, 15000);

  // Default cap (max): the score is rounded to the nearest of the five levels
  // and an exact tie goes to the even level (low, high, high, max).
  it.each([
    [0, "low"],
    [0.25, "low"],
    [0.49, "low"],
    [0.5, "low"],
    [0.51, "medium"],
    [1, "medium"],
    [1.49, "medium"],
    [1.5, "high"],
    [2, "high"],
    [2.49, "high"],
    [2.5, "high"],
    [2.51, "xhigh"],
    [3.49, "xhigh"],
    [3.5, "max"],
    [4, "max"],
  ])("maps effort score %s to %s under the default cap", async (score, expected) => {
    answersFor = () => ({ effort: scoreAnswer(score), "model-tier": choiceAnswer("sonnet") });
    const routed = await routedInput(agentInput());
    expect(routed.model).toBe("sonnet");
    expect(routed.effort).toBe(expected);
  }, 15000);

  it.each([
    [0.4, "low"],
    [1.2, "medium"],
    [2.4, "high"],
    [2.6, "high"],
    [3.6, "high"],
    [4, "high"],
  ])("maps effort score %s to %s under OMC_JEV_MAX_EFFORT=high", async (score, expected) => {
    answersFor = () => ({ effort: scoreAnswer(score), "model-tier": choiceAnswer("sonnet") });
    expect((await routedInput(agentInput(), { OMC_JEV_MAX_EFFORT: "high" })).effort).toBe(expected);
  }, 15000);

  it("ignores the confidence of the effort answer", async () => {
    for (const confidence of [0, 0.5, 0.99, 1]) {
      answersFor = () => ({ effort: scoreAnswer(3.6, confidence), "model-tier": choiceAnswer("opus") });
      expect((await routedInput(agentInput(), { OMC_JEV_MAX_EFFORT: "max" })).effort).toBe("max");
    }
    const withoutConfidence: Record<string, unknown> = { ...scoreAnswer(3.6) };
    delete withoutConfidence.confidence;
    answersFor = () => ({ effort: withoutConfidence, "model-tier": choiceAnswer("opus") });
    expect((await routedInput(agentInput(), { OMC_JEV_MAX_EFFORT: "max" })).effort).toBe("max");
  }, 15000);

  it.each([
    // [cap, score, expected]
    ["xhigh", 2.51, "xhigh"],
    ["xhigh", 3, "xhigh"],
    ["xhigh", 3.5, "xhigh"],
    ["xhigh", 4, "xhigh"],
    ["xhigh", 2.49, "high"],
    ["max", 2.5, "high"],
    ["max", 2.51, "xhigh"],
    ["max", 3, "xhigh"],
    ["max", 3.49, "xhigh"],
    ["max", 3.5, "max"],
    ["max", 3.51, "max"],
    ["max", 4, "max"],
    ["max", 2.49, "high"],
    ["max", 0.4, "low"],
    ["MAX", 4, "max"],
    [" max ", 4, "max"],
  ])("with OMC_JEV_MAX_EFFORT=%s maps score %s to %s", async (cap, score, expected) => {
    answersFor = () => ({ effort: scoreAnswer(score), "model-tier": choiceAnswer("opus") });
    expect((await routedInput(agentInput(), { OMC_JEV_MAX_EFFORT: cap })).effort).toBe(expected);
  }, 15000);

  it("reads answers by name when effort comes before model-tier", async () => {
    answersFor = () => ({ effort: scoreAnswer(2.4), "model-tier": choiceAnswer("opus") });
    const routed = await routedInput(agentInput());
    expect(routed).toEqual({ ...agentInput().tool_input, model: "opus", effort: "high" });

    answersFor = () => ({ "model-tier": choiceAnswer("haiku"), effort: scoreAnswer(0.4) });
    const reversed = await routedInput(agentInput({ model: "opus" }));
    expect(reversed).toEqual({ ...agentInput().tool_input, model: "haiku", effort: "low" });
  }, 15000);

  it("Jev effort replaces an explicit effort, the lowest scores included", async () => {
    answersFor = () => ({ effort: scoreAnswer(0.4), "model-tier": choiceAnswer("sonnet") });
    expect((await routedInput(agentInput({ effort: "high" }))).effort).toBe("low");

    answersFor = () => ({ effort: scoreAnswer(0.1), "model-tier": choiceAnswer("sonnet") });
    expect(await routedInput(agentInput({ effort: "medium" }))).toEqual({
      ...agentInput().tool_input,
      model: "sonnet",
      effort: "low",
    });
  }, 15000);

  it("caps the mapped effort at OMC_JEV_MAX_EFFORT", async () => {
    answersFor = () => ({ effort: scoreAnswer(3.8, 1), "model-tier": choiceAnswer("opus") });
    expect((await routedInput(agentInput(), { OMC_JEV_MAX_EFFORT: "medium" })).effort).toBe("medium");
    expect((await routedInput(agentInput(), { OMC_JEV_MAX_EFFORT: "low" })).effort).toBe("low");
    expect((await routedInput(agentInput(), { OMC_JEV_MAX_EFFORT: "high" })).effort).toBe("high");
    expect((await routedInput(agentInput(), { OMC_JEV_MAX_EFFORT: "xhigh" })).effort).toBe("xhigh");
    expect((await routedInput(agentInput(), { OMC_JEV_MAX_EFFORT: "max" })).effort).toBe("max");
    // Unknown cap values fall back to the default cap (max).
    expect((await routedInput(agentInput(), { OMC_JEV_MAX_EFFORT: "turbo" })).effort).toBe("max");
    // Lower levels are not raised by a higher cap.
    answersFor = () => ({ effort: scoreAnswer(1.6, 1), "model-tier": choiceAnswer("opus") });
    expect((await routedInput(agentInput(), { OMC_JEV_MAX_EFFORT: "max" })).effort).toBe("high");
  }, 15000);

  it("reports an unknown OMC_JEV_MAX_EFFORT on stderr unless OMC_JEV_QUIET=1", async () => {
    const loud = await runEnforcer(agentInput(), { ...env, OMC_JEV_QUIET: undefined, OMC_JEV_MAX_EFFORT: "hihg" }, cwd);
    expect(loud.exitCode, loud.stderr).toBe(0);
    expect(loud.stderr).toContain("OMC_JEV_MAX_EFFORT=hihg");
    const quiet = await runEnforcer(agentInput(), { ...env, OMC_JEV_MAX_EFFORT: "hihg" }, cwd);
    expect(quiet.stderr).not.toContain("OMC_JEV_MAX_EFFORT");
    const valid = await runEnforcer(agentInput(), { ...env, OMC_JEV_QUIET: undefined, OMC_JEV_MAX_EFFORT: "high" }, cwd);
    expect(valid.stderr).not.toContain("OMC_JEV_MAX_EFFORT");
  }, 30000);

  it("explicit max is replaced by Jev effort, or capped when Jev gives no effort answer", async () => {
    answersFor = () => ({ effort: scoreAnswer(1.9), "model-tier": choiceAnswer("opus") });
    expect((await routedInput(agentInput({ effort: "max" }))).effort).toBe("high");

    answersFor = () => ({ "model-tier": choiceAnswer("opus") });
    const capped = await routedInput(agentInput({ effort: "max" }), { OMC_JEV_MAX_EFFORT: "high" });
    expect(capped).toEqual({ ...agentInput().tool_input, model: "opus", effort: "high" });
    // The default cap is max, so an explicit max stays.
    expect((await routedInput(agentInput({ effort: "max" }))).effort).toBe("max");
    expect((await routedInput(agentInput({ effort: "xhigh" }), { OMC_JEV_MAX_EFFORT: "medium" })).effort).toBe(
      "medium",
    );
    expect((await routedInput(agentInput({ effort: "max" }), { OMC_JEV_MAX_EFFORT: "max" })).effort).toBe("max");
    expect((await routedInput(agentInput({ effort: "max" }), { OMC_JEV_MAX_EFFORT: "xhigh" })).effort).toBe("xhigh");
  }, 15000);

  it("leaves effort unchanged when the response has no effort answer or a malformed score", async () => {
    answersFor = () => ({ "model-tier": choiceAnswer("opus") });
    expect(await routedInput(agentInput({ effort: "medium" }))).toEqual({
      ...agentInput().tool_input,
      model: "opus",
      effort: "medium",
    });
    expect(await routedInput(agentInput())).not.toHaveProperty("effort");

    answersFor = () => ({ effort: { ...scoreAnswer(1), score: "high" }, "model-tier": choiceAnswer("opus") });
    expect((await routedInput(agentInput({ effort: "low" }))).effort).toBe("low");
  }, 15000);

  it.each([
    ["score -1", { ...scoreAnswer(0), score: -1 }],
    ["score 99", { ...scoreAnswer(0), score: 99 }],
    ["score 4.01", { ...scoreAnswer(0), score: 4.01 }],
    ["a choice answer carrying a score", { ...choiceAnswer("high"), score: 2 }],
    ["score NaN as text", { ...scoreAnswer(0), score: "NaN" }],
  ])("treats %s as a missing effort answer", async (_label, effortAnswer) => {
    answersFor = () => ({ effort: effortAnswer, "model-tier": choiceAnswer("opus") });
    // Explicit effort within the cap stays as it was.
    expect(await routedInput(agentInput({ effort: "medium" }))).toEqual({
      ...agentInput().tool_input,
      model: "opus",
      effort: "medium",
    });
    // No explicit effort: none is added.
    expect(await routedInput(agentInput())).not.toHaveProperty("effort");
    // Explicit effort above the cap is lowered to the cap, as with no effort answer.
    expect((await routedInput(agentInput({ effort: "max" }), { OMC_JEV_MAX_EFFORT: "high" })).effort).toBe("high");
  }, 15000);

  it("applies the effort answer when model-tier is missing", async () => {
    answersFor = () => ({ effort: scoreAnswer(0.9) });
    expect(await routedInput(agentInput())).toEqual({ ...agentInput().tool_input, effort: "medium" });
  }, 15000);

  it("degraded Jev leaves the input exactly as without Jev, explicit max included", async () => {
    const input = agentInput({ effort: "max" });
    const baseline = await runEnforcer(input, { ...env, OMC_JEV: undefined }, cwd);
    expect(requests).toHaveLength(0);
    status = 500;
    const degraded = await runEnforcer(input, env, cwd);
    expect(baseline.exitCode, baseline.stderr).toBe(0);
    expect(degraded.exitCode, degraded.stderr).toBe(0);
    expect(requests).toHaveLength(1);
    expect(degraded.stdout).toBe(baseline.stdout);
  }, 15000);

  it("plan mode with OMC_JEV_PLAN_MODE=shadow leaves the input exactly as without Jev, explicit max included", async () => {
    answersFor = () => ({ effort: scoreAnswer(0.4), "model-tier": choiceAnswer("opus") });
    const input = { ...agentInput({ effort: "max" }), permission_mode: "plan" };
    const baseline = await runEnforcer(input, { ...env, OMC_JEV: undefined }, cwd);
    const planned = await runEnforcer(input, { ...env, OMC_JEV_PLAN_MODE: "shadow" }, cwd);
    expect(baseline.exitCode, baseline.stderr).toBe(0);
    expect(planned.exitCode, planned.stderr).toBe(0);
    expect(planned.stdout).toBe(baseline.stdout);
    // Jev is still asked (shadow), so wait for the detached resolver before cleanup.
    await waitFor(
      () => {
        const entries = readFileSync(join(cwd, "jev-logs", "shadow.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ point: "model-routing", mode: "shadow" })]),
        );
      },
      { timeout: 5000, interval: 25 },
    );
  }, 15000);

  it("shadow mode keeps the input and logs every answer by name", async () => {
    answersFor = () => ({ effort: scoreAnswer(2.2), "model-tier": choiceAnswer("opus") });
    const input = agentInput({ effort: "max" });
    const baseline = await runEnforcer(input, { ...env, OMC_JEV: undefined }, cwd);
    const shadow = await runEnforcer(input, { ...env, OMC_JEV: "model-routing" }, cwd);
    expect(shadow.exitCode, shadow.stderr).toBe(0);
    expect(shadow.stdout).toBe(baseline.stdout);
    await waitFor(
      () => {
        const entries = readFileSync(join(cwd, "jev-logs", "shadow.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const entry = entries.find((line) => line.point === "model-routing" && line.mode === "shadow");
        expect(entry).toBeDefined();
        expect(entry.answers["model-tier"].choice).toBe("opus");
        expect(entry.answers.effort.score).toBe(2.2);
        // jev/confidence come from the first question asked, not the first answer sent.
        expect(entry.jev.choice).toBe("opus");
        expect(entry.confidence).toBe(0.9);
        // The heuristic is the twin's tier, the comparable answer to the first question.
        expect(entry.heuristic).toBe("haiku");
      },
      { timeout: 5000, interval: 25 },
    );
  }, 15000);
});
