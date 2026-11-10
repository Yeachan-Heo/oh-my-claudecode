/**
 * model-routing hints: real pre-tool-enforcer.mjs subprocess against a mock Jev endpoint.
 * With OMC_JEV_MODEL_ROUTING_HINTS=1 the effort question gets two more sentences and the
 * Haiku description of the model-tier question gets a clause. Without the variable the
 * questions sent to Jev are exactly the base questions.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const API_KEY = "test-key-123";
const TASK = "List every file under src/auth that mentions a session token, one per line.";

// The base texts of the two fields the hints extend, written out so that a change to them
// is a visible change to this test.
const BASE_EFFORT_INSTRUCTIONS =
  "How much reasoning effort does this delegated task need? Judge the work the delegated agent must actually do. " +
  "The length of the brief and its formal conditions (language and style rules, permission to use subagents, bans, " +
  "file locations, report format, words in capitals) do not raise the level.";
const BASE_HAIKU =
  "Haiku: mechanical work whose result follows directly from the data and is easy to check: look up, read, list, count, copy, compile a list, run a command and report the result, one obvious fix";
const HINT_EFFORT =
  " Mechanical work gets the low level only when it is short: one action or a few. " +
  "Mechanical work with more than ten items or steps gets the medium level, " +
  "and with several dozen or more, or when every item has to be checked, the high level.";
const HINT_HAIKU = "; also when there are very many such actions or each one has to be checked";

type Question = { instructions: string; criteria: Record<string, string> | string[] };
type Request = { state: Record<string, unknown>; questions: Record<string, Question> };

function runEnforcer(input: Record<string, unknown>, env: NodeJS.ProcessEnv) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
    const child = spawn(process.execPath, [join(PROJECT_ROOT, "scripts", "pre-tool-enforcer.mjs")], {
      cwd: PROJECT_ROOT,
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

describe("pre-tool-enforcer.mjs: model-routing hints", () => {
  let cwd: string;
  let env: NodeJS.ProcessEnv;
  let server: Server;
  let requests: Request[];
  let answers: Record<string, unknown>;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "jev-hints-"));
    requests = [];
    answers = {
      "model-tier": { type: "choice", choice: "haiku", confidence: 0.9 },
      effort: { type: "score", score: 1, confidence: 0.7 },
    };
    server = createServer((request, response) => {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        raw += chunk;
      });
      request.on("end", () => {
        requests.push(JSON.parse(raw));
        response.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
        response.end(JSON.stringify({ answers }));
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
    rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  function agentInput(prompt: string, extra: Record<string, unknown> = {}) {
    return {
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: {
        description: "List the files",
        prompt,
        subagent_type: "general-purpose",
        model: "sonnet",
        ...extra,
      },
      cwd,
      session_id: "test-sess-hints",
    };
  }

  async function routedInput(input: ReturnType<typeof agentInput>, extraEnv: NodeJS.ProcessEnv = {}) {
    const result = await runEnforcer(input, { ...env, ...extraEnv });
    expect(result.exitCode, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.continue).toBe(true);
    return (output.hookSpecificOutput?.updatedInput ?? input.tool_input) as Record<string, unknown>;
  }

  it("sends the base texts of the two extended fields without the variable", async () => {
    await routedInput(agentInput(TASK));
    expect(requests).toHaveLength(1);
    const { questions } = requests[0];
    expect(questions.effort.instructions).toBe(BASE_EFFORT_INSTRUCTIONS);
    expect(questions["model-tier"].criteria.haiku).toBe(BASE_HAIKU);
    expect(Object.keys(questions)).toEqual(["model-tier", "effort"]);
    expect(JSON.stringify(questions)).not.toContain("also when there are very many");
    expect(JSON.stringify(questions)).not.toContain("only when it is short");
  }, 15000);

  it.each(["0", "no", "", "yes"])("stays off for OMC_JEV_MODEL_ROUTING_HINTS=%j", async (value) => {
    await routedInput(agentInput(TASK), { OMC_JEV_MODEL_ROUTING_HINTS: value });
    const { questions } = requests[0];
    expect(questions.effort.instructions).toBe(BASE_EFFORT_INSTRUCTIONS);
    expect(questions["model-tier"].criteria.haiku).toBe(BASE_HAIKU);
  }, 15000);

  it.each(["1", "true", " TRUE "])("adds both hints for OMC_JEV_MODEL_ROUTING_HINTS=%j", async (value) => {
    await routedInput(agentInput(TASK), { OMC_JEV_MODEL_ROUTING_HINTS: value });
    expect(requests).toHaveLength(1);
    const { questions } = requests[0];
    expect(questions.effort.instructions).toBe(BASE_EFFORT_INSTRUCTIONS + HINT_EFFORT);
    expect(questions["model-tier"].criteria.haiku).toBe(BASE_HAIKU + HINT_HAIKU);
  }, 15000);

  it("changes nothing else in the questions or in the state", async () => {
    await routedInput(agentInput(TASK));
    await routedInput(agentInput(TASK), { OMC_JEV_MODEL_ROUTING_HINTS: "1" });
    expect(requests).toHaveLength(2);
    const [off, on] = requests;
    const withoutHints = (request: Request) => {
      const copy = JSON.parse(JSON.stringify(request)) as Request;
      copy.questions.effort.instructions = "";
      copy.questions["model-tier"].criteria.haiku = "";
      return copy;
    };
    expect(withoutHints(on)).toEqual(withoutHints(off));
  }, 30000);

  it("applies Jev's answers as before", async () => {
    answers = {
      "model-tier": { type: "choice", choice: "haiku", confidence: 0.9 },
      effort: { type: "score", score: 2, confidence: 0.7 },
    };
    const routed = await routedInput(agentInput(TASK), { OMC_JEV_MODEL_ROUTING_HINTS: "1" });
    expect(routed.model).toBe("haiku");
    expect(routed.effort).toBe("high");
  }, 15000);

  describe("with the use marker (OMC_JEV_MODEL_ROUTING_MARKER)", () => {
    const markerEnv = { OMC_JEV_MODEL_ROUTING_MARKER: "1", OMC_JEV_MODEL_ROUTING_HINTS: "1" };

    it("a pinned model leaves only the effort question, with its hint", async () => {
      const routed = await routedInput(agentInput(`use opus\n${TASK}`), markerEnv);
      expect(routed.model).toBe("opus");
      expect(Object.keys(requests[0].questions)).toEqual(["effort"]);
      expect(requests[0].questions.effort.instructions).toBe(BASE_EFFORT_INSTRUCTIONS + HINT_EFFORT);
    }, 15000);

    it("a pinned effort leaves only the model-tier question, with its hint", async () => {
      const routed = await routedInput(agentInput(`use high\n${TASK}`), markerEnv);
      expect(routed.effort).toBe("high");
      expect(Object.keys(requests[0].questions)).toEqual(["model-tier"]);
      expect(requests[0].questions["model-tier"].criteria.haiku).toBe(BASE_HAIKU + HINT_HAIKU);
    }, 15000);

    it("a pinned model and effort send nothing to Jev", async () => {
      const routed = await routedInput(agentInput(`use opus high\n${TASK}`), markerEnv);
      expect(requests).toHaveLength(0);
      expect(routed.model).toBe("opus");
      expect(routed.effort).toBe("high");
      expect(routed.prompt).toBe(TASK);
    }, 15000);
  });

  describe("with the effort cap", () => {
    it("OMC_JEV_MAX_EFFORT still caps the effort chosen from the answer", async () => {
      answers = {
        "model-tier": { type: "choice", choice: "sonnet", confidence: 0.9 },
        effort: { type: "score", score: 3, confidence: 0.7 },
      };
      const routed = await routedInput(agentInput(TASK), { OMC_JEV_MODEL_ROUTING_HINTS: "1", OMC_JEV_MAX_EFFORT: "medium" });
      expect(routed.effort).toBe("medium");
    }, 15000);

    it("OMC_JEV_MAX_EFFORT_ALWAYS still lowers an explicit effort when Jev is not asked", async () => {
      const routed = await routedInput(agentInput(TASK, { model: "gpt-5", effort: "xhigh" }), {
        OMC_JEV_MODEL_ROUTING_HINTS: "1",
        OMC_JEV_MAX_EFFORT: "medium",
        OMC_JEV_MAX_EFFORT_ALWAYS: "1",
      });
      expect(requests).toHaveLength(0);
      expect(routed.effort).toBe("medium");
    }, 15000);
  });

  it("works together with the fable opt-in: both the hint and the fable choice are in the question", async () => {
    await routedInput(agentInput(TASK), { OMC_JEV_MODEL_ROUTING_HINTS: "1", OMC_JEV_MODEL_ROUTING_FABLE: "1" });
    const { questions } = requests[0];
    expect(questions["model-tier"].criteria.haiku).toBe(BASE_HAIKU + HINT_HAIKU);
    expect(Object.keys(questions["model-tier"].criteria)).toEqual(["haiku", "sonnet", "opus", "fable"]);
    expect(questions.effort.instructions).toBe(BASE_EFFORT_INSTRUCTIONS + HINT_EFFORT);
  }, 15000);
});
